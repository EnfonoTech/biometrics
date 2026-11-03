// Copyright (c) 2026, Siva and contributors
// For license information, please see license.txt

// One grid per group (department, branch, ... per Group By): employees down, days across, each day coloured by when the employee
// first checked in. By default the colour is the time of day (flexible shifts care when people
// came, not whether they were late); "Highlight Late" colours by minutes after shift start instead.
// Data: biometrics.biometrics.checkin_register, shared with the Monthly Check-in Register report
// and the Employee Checkin calendar.

frappe.pages["checkin-heatmap"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("Check-in Heatmap"),
		single_column: true,
	});
	wrapper.heatmap = new CheckinHeatmap(page);
};

frappe.pages["checkin-heatmap"].on_page_show = function (wrapper) {
	wrapper.heatmap.show();
};

// [cell class, label] in legend order
const LATE_LEGEND = [
	["early", __("By shift start")],
	["grace", __("Within grace")],
	["late-1", __("Late ≤ 15 min")],
	["late-2", __("15–30 min")],
	["late-3", __("30–60 min")],
	["late-4", __("> 60 min")],
	["present", __("No late marking")],
];
const STATE_LEGEND = [
	["absent", __("Absent")],
	["leave", __("Leave / WFH")],
	["off", __("Holiday / weekly off")],
	["missing", __("No punch, not marked")],
];
const TIME_BUCKETS = 5;

class CheckinHeatmap {
	constructor(page) {
		this.page = page;
		this.request = 0;
		this.inject_styles();
		this.make_filters();
		this.$body = $(`<div class="bio-hm"></div>`).appendTo(page.main);

		page.set_primary_action(__("Refresh"), () => this.refresh(), "es-line-reload");
		page.add_inner_button(__("Register"), () => {
			frappe.route_options = { ...this.values(), highlight_late: this.highlight_late() };
			frappe.set_route("query-report", "Monthly Check-in Register");
		});
		page.add_inner_button(__("Calendar"), () => {
			frappe.route_options = {};
			frappe.set_route("List", "Employee Checkin", "Calendar", "default");
		});

		this.$body.on("click", ".bio-hm-cell[data-employee]", (e) => this.open_day($(e.currentTarget)));
	}

	make_filters() {
		const now = moment();
		const add = (df) => this.page.add_field(df);
		const refresh = () => this.refresh();
		const rerender = () => this.data && this.render();
		this.fields = {
			company: add({
				fieldname: "company",
				label: __("Company"),
				fieldtype: "Link",
				options: "Company",
				default: frappe.defaults.get_user_default("Company"),
				reqd: 1,
				change: refresh,
			}),
			month: add({
				fieldname: "month",
				label: __("Month"),
				fieldtype: "Select",
				options: moment.months().map((label, i) => ({ value: String(i + 1), label: __(label) })),
				default: String(now.month() + 1),
				change: refresh,
			}),
			year: add({
				fieldname: "year",
				label: __("Year"),
				fieldtype: "Select",
				options: [0, 1, 2, 3, 4].map((i) => String(now.year() - i)),
				default: String(now.year()),
				change: refresh,
			}),
			department: add({
				fieldname: "department",
				label: __("Department"),
				fieldtype: "Link",
				options: "Department",
				get_query: () => ({ filters: { company: this.fields.company.get_value() } }),
				change: refresh,
			}),
			branch: add({
				fieldname: "branch",
				label: __("Branch"),
				fieldtype: "Link",
				options: "Branch",
				change: refresh,
			}),
			group_by: add({
				fieldname: "group_by",
				label: __("Group By"),
				fieldtype: "Select",
				options: ["Department", "Branch", "Designation", "Employment Type", "Grade", "Shift", "Reports To", "None"]
					.map((value) => ({ value, label: __(value) })),
				default: "Department",
				change: refresh,
			}),
			show_times: add({
				fieldname: "show_times",
				label: __("Show Times"),
				fieldtype: "Check",
				default: 1,
				change: rerender,
			}),
			highlight_late: add({
				fieldname: "highlight_late",
				label: __("Highlight Late"),
				fieldtype: "Check",
				change: rerender,
			}),
		};
	}

	values() {
		const v = {};
		for (const key of ["company", "month", "year", "department", "branch", "group_by"]) {
			v[key] = this.fields[key].get_value();
		}
		return v;
	}

	highlight_late() {
		return this.fields.highlight_late.get_value() ? 1 : 0;
	}

	show() {
		// filters handed over from the report
		const options = frappe.route_options;
		frappe.route_options = null;
		if (options) {
			for (const [key, value] of Object.entries(options)) {
				if (this.fields[key] && value != null) {
					this.fields[key].set_value(this.fields[key].df.fieldtype === "Check" ? value : String(value));
				}
			}
		}
		this.refresh();
	}

	refresh() {
		const args = this.values();
		if (!args.company || !args.month || !args.year) return;

		// filter changes fire in bursts; only the last request may render
		const request = ++this.request;
		if (!this.data) this.$body.html(`<div class="bio-hm-empty">${__("Loading...")}</div>`);
		frappe
			.call("biometrics.biometrics.checkin_register.get_checkin_register", args)
			.then((r) => {
				if (request !== this.request) return;
				this.data = r.message;
				this.render();
			});
	}

	render() {
		const d = this.data;
		this.show_times = this.fields.show_times.get_value();
		this.late = this.highlight_late();
		if (!d.groups.length) {
			this.$body.html(`<div class="bio-hm-empty">${__("No employees match these filters.")}</div>`);
			return;
		}
		this.thresholds = this.time_thresholds(d);

		this.$body.html(`
			<div class="bio-hm-title">${frappe.utils.escape_html(d.month_label)}</div>
			${this.kpis(d.summary)}
			<div class="bio-hm-charts">
				<div class="bio-hm-card">
					<div class="bio-hm-card-title">${__("Arrival times")}</div>
					<div class="bio-hm-chart-arrivals"></div>
				</div>
				<div class="bio-hm-card">
					<div class="bio-hm-card-title">${this.late ? __("Late arrivals per day") : __("Checked in per day")}</div>
					<div class="bio-hm-chart-daily"></div>
				</div>
			</div>
			<div class="bio-hm-legend">${this.legend()}</div>
			${d.groups.map((group) => this.group(group, d.days)).join("")}
		`);
		this.render_charts();
	}

	// split the month's check-in times into equal-sized groups, so the colours spread whatever the hours
	time_thresholds(d) {
		const times = [];
		for (const group of d.groups)
			for (const emp of group.employees) for (const c of emp.cells) if (c.time) times.push(c.minute_of_day);
		times.sort((a, b) => a - b);
		if (!times.length) return [];
		const cuts = [];
		for (let i = 1; i < TIME_BUCKETS; i++) cuts.push(times[Math.floor((times.length * i) / TIME_BUCKETS)]);
		return [...new Set(cuts)];
	}

	time_bucket(minute) {
		const i = this.thresholds.findIndex((cut) => minute < cut);
		return i === -1 ? this.thresholds.length : i;
	}

	legend() {
		const swatch = ([cls, label]) => `<span><i class="bio-hm-swatch c-${cls}"></i>${label}</span>`;
		let items = LATE_LEGEND;
		if (!this.late) {
			const hhmm = (m) => moment().startOf("day").add(m, "minutes").format("HH:mm");
			const cuts = this.thresholds;
			items = [0, ...cuts].map((from, i) => {
				const label =
					i === 0
						? __("Before {0}", [hhmm(cuts[0] ?? 1440)])
						: i === cuts.length
						? __("{0} or later", [hhmm(from)])
						: `${hhmm(from)}–${hhmm(cuts[i] - 1)}`;
				return [`t-${i}`, label];
			});
		}
		return [...items, ...STATE_LEGEND].map(swatch).join("");
	}

	kpis(s) {
		const kpi = (label, value, sub, cls = "") =>
			`<div class="bio-hm-kpi ${cls}">
				<div class="bio-hm-kpi-label">${label}</div>
				<div class="bio-hm-kpi-value">${value}</div>
				<div class="bio-hm-kpi-sub">${sub || "&nbsp;"}</div>
			</div>`;
		return `<div class="bio-hm-kpis">
			${kpi(__("Employees"), s.employees)}
			${kpi(__("Avg Check-in"), s.avg_in || "–", __("{0} check-in days", [s.present]))}
			${kpi(__("Earliest"), s.earliest || "–", "", "good")}
			${kpi(__("Latest"), s.latest || "–", "", "warn")}
			${
				this.late
					? kpi(__("On Time"), this.pct(s.on_time_pct), __("{0} late, avg {1} min", [s.late, s.avg_late || 0]), "good")
					: ""
			}
			${kpi(__("Absent Days"), s.absent, "", "bad")}
			${kpi(__("Leave Days"), s.leave)}
		</div>`;
	}

	group(group, days) {
		const esc = frappe.utils.escape_html;
		const s = group.stats;
		const range = (x) => (x.earliest ? `${x.earliest}–${x.latest}` : "–");
		const head = days
			.map(
				(day) => `<th class="bio-hm-day ${day.is_today ? "today" : ""}" title="${day.date}">
					<div>${day.day}</div><div class="bio-hm-wd">${esc(day.weekday.slice(0, 2))}</div>
				</th>`
			)
			.join("");

		const rows = group.employees
			.map(
				(emp) => `<tr>
					<th class="bio-hm-name">
						<a href="/app/employee/${encodeURIComponent(emp.employee)}">${esc(emp.employee_name)}</a>
						<div class="bio-hm-sub">${esc(emp.designation || emp.employee)}</div>
					</th>
					${emp.cells.map((cell, i) => this.cell(cell, emp, days[i])).join("")}
					<td class="bio-hm-stat"><b>${emp.stats.avg_in || "–"}</b></td>
					<td class="bio-hm-stat">${range(emp.stats)}</td>
					${this.late ? `<td class="bio-hm-stat">${this.pct(emp.stats.on_time_pct)}</td>` : ""}
				</tr>`
			)
			.join("");

		const daily = group.daily
			.map((x) => {
				const tip = __("{0} of {1} checked in, {2} absent", [x.present, x.expected, x.absent]);
				return `<td class="bio-hm-count" title="${esc(tip)}">${x.expected ? x.present : ""}</td>`;
			})
			.join("");

		const on_time = s.on_time_pct == null ? 0 : s.on_time_pct;
		return `<div class="bio-hm-card bio-hm-group">
			<div class="bio-hm-group-head">
				<div>
					<div class="bio-hm-group-name">${esc(group.group)}</div>
					<div class="bio-hm-sub">${__("{0} employees", [group.headcount])}</div>
				</div>
				<div class="bio-hm-pills">
					<span>${__("Avg check-in")} <b>${s.avg_in || "–"}</b></span>
					<span>${__("Range")} <b>${range(s)}</b></span>
					${
						this.late
							? `<span>${__("On time")} <b>${this.pct(s.on_time_pct)}</b>
								<i class="bio-hm-bar"><i style="width:${on_time}%"></i></i></span>
							<span>${__("Late")} <b>${s.late}</b></span>`
							: ""
					}
					<span>${__("Absent")} <b>${s.absent}</b></span>
					<span>${__("Leave")} <b>${s.leave}</b></span>
				</div>
			</div>
			<div class="bio-hm-scroll">
				<table class="bio-hm-grid ${this.show_times ? "with-times" : ""}">
					<thead><tr>
						<th class="bio-hm-name">${__("Employee")}</th>${head}
						<th class="bio-hm-stat">${__("Avg In")}</th>
						<th class="bio-hm-stat">${__("Range")}</th>
						${this.late ? `<th class="bio-hm-stat">${__("On Time")}</th>` : ""}
					</tr></thead>
					<tbody>
						${rows}
						<tr class="bio-hm-daily"><th class="bio-hm-name">${__("Checked in")}</th>${daily}</tr>
					</tbody>
				</table>
			</div>
		</div>`;
	}

	cell(c, emp, day) {
		const esc = frappe.utils.escape_html;
		const letter = { absent: "A", leave: "L", half_day: "HD", wfh: "W" }[c.state] || "";
		const text = this.show_times ? c.time || c.code || "" : c.time ? "" : letter;
		const link = c.checkin || c.attendance;
		const data = link
			? `data-employee="${esc(emp.employee)}" data-date="${day.date}" data-checkin="${esc(c.checkin || "")}"
				data-attendance="${esc(c.attendance || "")}" data-punches="${c.punches || 0}"`
			: "";
		return `<td class="bio-hm-cell c-${this.cell_class(c)}" title="${esc(this.tip(c, emp, day))}" ${data}>${text}</td>`;
	}

	cell_class(c) {
		if (c.time) {
			if (!this.late) return `t-${this.time_bucket(c.minute_of_day)}`;
			if (c.state === "present") return "present";
			if (c.state === "ontime") return c.minutes <= 0 ? "early" : "grace";
			if (c.minutes <= 15) return "late-1";
			if (c.minutes <= 30) return "late-2";
			if (c.minutes <= 60) return "late-3";
			return "late-4";
		}
		return (
			{
				absent: "absent",
				leave: "leave",
				half_day: "leave",
				wfh: "leave",
				present: "present",
				holiday: "off",
				weekly_off: "off",
				missing: "missing",
			}[c.state] || "none"
		);
	}

	tip(c, emp, day) {
		const head = `${emp.employee_name} · ${day.weekday} ${day.day}`;
		if (c.time) {
			const lines = [head, __("First check-in {0}", [c.time])];
			if (c.minutes != null) {
				lines.push(
					c.minutes > 0
						? __("{0} min after shift start", [c.minutes])
						: __("{0} min before shift start", [-c.minutes])
				);
			}
			if (c.last_time) lines.push(__("{0} punches, last {1}", [c.punches, c.last_time]));
			return lines.join("\n");
		}
		const label = {
			absent: __("Absent"),
			leave: __("On Leave"),
			half_day: __("Half Day"),
			wfh: __("Work From Home"),
			present: __("Present (no check-in)"),
			holiday: __("Holiday"),
			weekly_off: __("Weekly Off"),
			missing: __("No check-in, attendance not marked"),
			pending: __("Today, no check-in yet"),
			inactive: __("Not employed on this day"),
		}[c.state];
		return label ? `${head}\n${label}${c.note ? ": " + c.note : ""}` : head;
	}

	open_day($cell) {
		const { employee, date, checkin, attendance, punches } = $cell.data();
		if (checkin && punches > 1) {
			frappe.route_options = { employee, time: ["between", [date, date]] };
			frappe.set_route("List", "Employee Checkin");
		} else if (checkin) {
			frappe.set_route("Form", "Employee Checkin", checkin);
		} else if (attendance) {
			frappe.set_route("Form", "Attendance", attendance);
		}
	}

	render_charts() {
		const d = this.data;
		new frappe.Chart(this.$body.find(".bio-hm-chart-arrivals")[0], {
			type: "bar",
			height: 220,
			barOptions: { stacked: 1, spaceRatio: 0.3 },
			data: d.arrivals,
			tooltipOptions: { formatTooltipY: (v) => __("{0} check-ins", [v]) },
		});

		const key = this.late ? "late" : "present";
		new frappe.Chart(this.$body.find(".bio-hm-chart-daily")[0], {
			type: "bar",
			height: 220,
			barOptions: { stacked: 1, spaceRatio: 0.3 },
			axisOptions: { xIsSeries: 1 },
			data: {
				labels: d.days.map((x) => String(x.day)),
				datasets: d.groups.map((group) => ({
					name: group.group,
					values: group.daily.map((x) => x[key]),
				})),
			},
		});
	}

	pct(value) {
		return value == null ? "–" : `${Math.round(value)}%`;
	}

	inject_styles() {
		if (document.getElementById("bio-hm-style")) return;
		$(`<style id="bio-hm-style">
			.bio-hm { padding: 4px 0 24px; }
			.bio-hm-title { font-size: var(--text-xl); font-weight: 600; margin: 4px 0 12px; }
			.bio-hm-empty { padding: 60px 0; text-align: center; color: var(--text-muted); }
			.bio-hm-card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--border-radius-lg); padding: 14px 16px; margin-bottom: 14px; }
			.bio-hm-card-title { font-weight: 600; color: var(--text-muted); font-size: var(--text-sm); }
			.bio-hm-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 14px; }
			.bio-hm-kpi { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--border-radius-lg); padding: 12px 14px; border-top: 3px solid var(--blue-500); }
			.bio-hm-kpi.good { border-top-color: #2f9e44; } .bio-hm-kpi.warn { border-top-color: #f08c00; } .bio-hm-kpi.bad { border-top-color: #e03131; }
			.bio-hm-kpi-label { font-size: var(--text-sm); color: var(--text-muted); }
			.bio-hm-kpi-value { font-size: 24px; font-weight: 700; line-height: 1.3; font-variant-numeric: tabular-nums; }
			.bio-hm-kpi-sub { font-size: var(--text-xs); color: var(--text-muted); }
			.bio-hm-charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 0 14px; }
			.bio-hm-legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: var(--text-sm); color: var(--text-muted); margin: 2px 0 14px; }
			.bio-hm-legend span { display: inline-flex; align-items: center; gap: 6px; }
			.bio-hm-swatch { display: inline-block; width: 14px; height: 14px; border-radius: 3px; }
			.bio-hm-group-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
			.bio-hm-group-name { font-size: var(--text-lg); font-weight: 600; }
			.bio-hm-sub { font-size: var(--text-xs); color: var(--text-muted); font-weight: normal; }
			.bio-hm-pills { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
			.bio-hm-pills > span { background: var(--subtle-fg); border-radius: 999px; padding: 3px 10px; font-size: var(--text-sm); color: var(--text-muted); }
			.bio-hm-pills b { color: var(--text-color); margin-left: 2px; }
			.bio-hm-bar { display: inline-block; vertical-align: middle; width: 50px; height: 6px; border-radius: 3px; background: var(--gray-300); margin-left: 6px; overflow: hidden; }
			.bio-hm-bar > i { display: block; height: 100%; background: #2f9e44; }
			.bio-hm-scroll { overflow-x: auto; }
			.bio-hm-grid { border-collapse: separate; border-spacing: 3px; font-size: 11px; }
			.bio-hm-grid th { font-weight: normal; color: var(--text-muted); }
			.bio-hm-name { position: sticky; left: 0; z-index: 1; background: var(--card-bg); text-align: left; min-width: 170px; max-width: 220px; padding-right: 10px; font-size: var(--text-sm); }
			.bio-hm-name a { color: var(--text-color); font-weight: 500; }
			.bio-hm-day { text-align: center; min-width: 24px; line-height: 1.2; }
			.bio-hm-day.today { color: var(--primary); font-weight: 700; }
			.bio-hm-wd { font-size: 10px; opacity: .75; }
			.bio-hm-cell { width: 24px; min-width: 24px; height: 26px; border-radius: 4px; text-align: center; font-weight: 600; color: #1f2933; font-variant-numeric: tabular-nums; }
			.with-times .bio-hm-cell { min-width: 42px; }
			.bio-hm-cell[data-employee] { cursor: pointer; }
			.bio-hm-cell[data-employee]:hover { outline: 2px solid var(--text-color); }
			.bio-hm-stat { text-align: center; padding: 0 6px; font-size: var(--text-sm); white-space: nowrap; font-variant-numeric: tabular-nums; }
			.bio-hm-count { text-align: center; color: var(--text-muted); font-variant-numeric: tabular-nums; }
			.bio-hm-daily th { font-style: italic; }
			.c-t-0 { background: #e7f5ff; } .c-t-1 { background: #c5e4fb; } .c-t-2 { background: #91c9f5; }
			.c-t-3 { background: #4dabf7; color: #fff !important; } .c-t-4 { background: #1864ab; color: #fff !important; }
			.c-early { background: #2f9e44; color: #fff !important; }
			.c-grace { background: #8ce99a; }
			.c-present { background: #c5e4fb; }
			.c-late-1 { background: #ffe066; }
			.c-late-2 { background: #ffc078; }
			.c-late-3 { background: #ff922b; }
			.c-late-4 { background: #e8590c; color: #fff !important; }
			.c-absent { background: #e03131; color: #fff !important; }
			.c-leave { background: #d0bfff; }
			.c-off { background: repeating-linear-gradient(135deg, var(--gray-300) 0 3px, var(--gray-100) 3px 7px); }
			.c-missing { background: transparent; box-shadow: inset 0 0 0 1px var(--gray-400); }
			.c-none { background: var(--subtle-fg); }
		</style>`).appendTo("head");
	}
}
