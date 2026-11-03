// Copyright (c) 2026, Siva and contributors
// For license information, please see license.txt

const BIO_CELL_STYLE = `
	.bio-cell { margin: -4px -8px; padding: 4px 6px; border-radius: 4px; text-align: center; font-variant-numeric: tabular-nums; }
	.bio-time { color: var(--text-color); background: var(--subtle-fg); }
	.bio-ontime { color: var(--green-700); background: var(--green-50); }
	.bio-late { color: var(--orange-700); background: var(--orange-100); font-weight: 600; }
	.bio-absent { color: var(--red-700); background: var(--red-100); font-weight: 600; }
	.bio-leave, .bio-half_day, .bio-wfh { color: var(--blue-700); background: var(--blue-50); }
	.bio-holiday, .bio-weekly_off { color: var(--gray-600); background: var(--gray-100); }
	.bio-missing { color: var(--gray-500); }
	.bio-group { color: var(--text-color); font-weight: 600; }
	.bio-legend { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 8px 0 4px; font-size: var(--text-sm); color: var(--text-muted); }
	.bio-legend .bio-cell { display: inline-block; margin: 0 4px 0 0; padding: 0 6px; min-width: 34px; }
`;

frappe.query_reports["Monthly Check-in Register"] = {
	filters: [
		{
			fieldname: "company",
			label: __("Company"),
			fieldtype: "Link",
			options: "Company",
			default: frappe.defaults.get_user_default("Company"),
			reqd: 1,
		},
		{
			fieldname: "month",
			label: __("Month"),
			fieldtype: "Select",
			options: moment.months().map((label, i) => ({ value: i + 1, label: __(label) })),
			default: moment().month() + 1,
			reqd: 1,
		},
		{
			fieldname: "year",
			label: __("Year"),
			fieldtype: "Select",
			options: [0, 1, 2, 3, 4].map((i) => String(moment().year() - i)),
			default: String(moment().year()),
			reqd: 1,
		},
		{
			fieldname: "department",
			label: __("Department"),
			fieldtype: "Link",
			options: "Department",
			get_query: () => ({
				filters: { company: frappe.query_report.get_filter_value("company") },
			}),
		},
		{
			fieldname: "branch",
			label: __("Branch"),
			fieldtype: "Link",
			options: "Branch",
		},
		{
			fieldname: "group_by",
			label: __("Group By"),
			fieldtype: "Select",
			options: ["Department", "Branch", "Designation", "Employment Type", "Grade", "Shift", "Reports To", "None"]
				.map((value) => ({ value, label: __(value) })),
			default: "Department",
			reqd: 1,
		},
		{
			fieldname: "employee",
			label: __("Employee"),
			fieldtype: "Link",
			options: "Employee",
			get_query: () => ({
				filters: { company: frappe.query_report.get_filter_value("company") },
			}),
		},
		{
			// the check-in time is the point; lateness only for shifts with late entry marking
			fieldname: "highlight_late",
			label: __("Highlight Late"),
			fieldtype: "Check",
			default: 0,
		},
	],

	tree: true,
	name_field: "label",
	parent_field: "parent_label",
	initial_depth: 1,

	onload(report) {
		if (!document.getElementById("bio-cell-style")) {
			$(`<style id="bio-cell-style">${BIO_CELL_STYLE}</style>`).appendTo("head");
		}

		report.page.add_inner_button(__("Heatmap"), () => {
			const f = report.get_values();
			frappe.route_options = {
				company: f.company,
				month: f.month,
				year: f.year,
				department: f.department,
				branch: f.branch,
				group_by: f.group_by,
				highlight_late: f.highlight_late,
			};
			frappe.set_route("checkin-heatmap");
		});
		report.page.add_inner_button(__("Calendar"), () => {
			const employee = report.get_values().employee;
			frappe.route_options = employee ? { employee } : {};
			frappe.set_route("List", "Employee Checkin", "Calendar", "default");
		});
	},

	after_datatable_render() {
		// runs after every refresh: redraw, so it follows Highlight Late and never piles up
		const report = frappe.query_report;
		const late = report.get_filter_value("highlight_late");
		const legend = [
			["time", "08:05", __("First check-in")],
			...(late ? [["ontime", "08:00", __("On time")], ["late", "08:20", __("Late")]] : []),
			["absent", "A", __("Absent")],
			["leave", "L", __("Leave")],
			["weekly_off", "WO", __("Weekly off")],
			["holiday", "H", __("Holiday")],
			["missing", "–", __("No punch, attendance not marked")],
			["group", "5/7", __("Checked in / expected")],
		];
		report.page.main.find(".bio-legend").remove();
		$(`<div class="bio-legend">${legend
			.map(([state, code, label]) => `<span><span class="bio-cell bio-${state}">${code}</span>${label}</span>`)
			.join("")}</div>`).insertBefore(report.page.main.find(".report-wrapper"));
	},

	formatter(value, row, column, data, default_formatter) {
		value = default_formatter(value, row, column, data);
		if (!data) return value;

		if (/^d\d+$/.test(column.fieldname)) {
			let state = data[`${column.fieldname}_state`];
			if (!state) return value;
			const judged = state === "ontime" || state === "late";
			if (String(data[column.fieldname] || "").includes(":") && !(judged && frappe.query_report.get_filter_value("highlight_late"))) {
				state = "time";
			}
			const tip = frappe.utils.escape_html(data[`${column.fieldname}_tip`] || "");
			return `<div class="bio-cell bio-${state}" title="${tip}">${value || "&nbsp;"}</div>`;
		}
		if (data.row_type === "group" && column.fieldname === "label") {
			return `<b>${value}</b>`;
		}
		return value;
	},
};
