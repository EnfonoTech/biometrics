// Copyright (c) 2026, Siva and contributors
// For license information, please see license.txt
//
// Injects Biometrics actions into the standard ERPNext Employee form.

frappe.ui.form.on("Employee", {
	refresh(frm) {
		if (frm.is_new()) return;

		// ── Sync Logs for This Employee ───────────────────────────────────────
		frm.add_custom_button(__("Sync Attendance Logs"), function () {
			_show_sync_logs_dialog(frm);
		}, __("Biometrics"));

		// ── Repair Missing Checkins ───────────────────────────────────────────
		frm.add_custom_button(__("Repair Missing Checkins"), function () {
			frappe.confirm(
				__("This will create Employee Checkin records for all transaction logs of {0} that are missing a checkin. Continue?", [frm.doc.employee_name]),
				function () {
					frappe.call({
						method: "biometrics.biometrics.api.endpoints.repair_employee_checkins",
						args: { employee: frm.doc.name },
						freeze: true,
						freeze_message: __("Repairing checkins..."),
						callback: function (r) {
							if (r.message) {
								let m = r.message;
								frappe.msgprint({
									title: __("Repair Complete"),
									message: __(
										"Checkins created: {0} &nbsp;|&nbsp; Already existed: {1} &nbsp;|&nbsp; Failed: {2}",
										[m.created, m.skipped, m.failed]
									),
									indicator: m.created > 0 ? "green" : "blue",
								});
							}
						},
					});
				}
			);
		}, __("Biometrics"));

		// ── Punch Summary ─────────────────────────────────────────────────────
		frm.add_custom_button(__("Punch Summary"), function () {
			_show_punch_summary_dialog(frm);
		}, __("Biometrics"));

		// ── Warn if attendance_device_id not set ──────────────────────────────
		if (!frm.doc.attendance_device_id) {
			frm.dashboard.set_headline_alert(
				__("Attendance Device ID is not set. Biometrics punches will not be imported for this employee."),
				"orange"
			);
		}
	},
});


function _show_sync_logs_dialog(frm) {
	let today = frappe.datetime.get_today();
	let week_ago = frappe.datetime.add_days(today, -7);

	let d = new frappe.ui.Dialog({
		title: __("Sync Attendance Logs — {0}", [frm.doc.employee_name]),
		fields: [
			{
				label: __("From Date"),
				fieldname: "date_from",
				fieldtype: "Date",
				default: week_ago,
				reqd: 1,
			},
			{
				label: __("To Date"),
				fieldname: "date_to",
				fieldtype: "Date",
				default: today,
				reqd: 1,
			},
			{
				fieldtype: "HTML",
				options: `<p class="text-muted small">
					Fetches punch records directly from the Biometrics machine for this employee
					within the selected date range. Existing records are never duplicated.
				</p>`,
			},
		],
		primary_action_label: __("Sync"),
		primary_action(values) {
			if (!frm.doc.attendance_device_id) {
				frappe.msgprint({
					title: __("Missing Attendance Device ID"),
					message: __("Set the Attendance Device ID on this Employee record first."),
					indicator: "red",
				});
				d.hide();
				return;
			}
			d.hide();
			frappe.call({
				method: "biometrics.biometrics.api.endpoints.sync_employee_logs",
				args: {
					employee: frm.doc.name,
					date_from: values.date_from,
					date_to: values.date_to,
				},
				freeze: true,
				freeze_message: __("Fetching punch logs from Biometrics machine..."),
				callback: function (r) {
					if (!r.message) return;
					let m = r.message;
					let indicator = m.created > 0 ? "green" : "blue";
					let errHtml = m.errors && m.errors.length
						? `<br><b>${__("Errors")}:</b><br>${m.errors.join("<br>")}`
						: "";
					frappe.msgprint({
						title: __("Sync Complete — {0}", [m.employee_name]),
						message: [
							__("Period: {0} → {1}", [m.date_from, m.date_to]),
							__("Device ID: {0}", [m.emp_code]),
							__("Fetched from machine: {0}", [m.total_fetched]),
							__("New logs created: {0}", [m.created]),
							__("Skipped (already exist): {0}", [m.skipped]),
							__("Employee Checkins created: {0}", [m.checkins_created]),
							errHtml,
						].join("<br>"),
						indicator: indicator,
					});
				},
			});
		},
	});
	d.show();
}


function _show_punch_summary_dialog(frm) {
	let today = frappe.datetime.get_today();
	let month_start = today.substring(0, 8) + "01";

	let d = new frappe.ui.Dialog({
		title: __("Punch Summary — {0}", [frm.doc.employee_name]),
		fields: [
			{
				label: __("From Date"),
				fieldname: "date_from",
				fieldtype: "Date",
				default: month_start,
				reqd: 1,
			},
			{
				label: __("To Date"),
				fieldname: "date_to",
				fieldtype: "Date",
				default: today,
				reqd: 1,
			},
		],
		primary_action_label: __("Show Summary"),
		primary_action(values) {
			d.hide();
			frappe.call({
				method: "biometrics.biometrics.api.endpoints.get_employee_punch_summary",
				args: {
					employee: frm.doc.name,
					date_from: values.date_from,
					date_to: values.date_to,
				},
				freeze: true,
				freeze_message: __("Generating summary..."),
				callback: function (r) {
					if (!r.message) return;
					let m = r.message;
					if (!m.days || !m.days.length) {
						frappe.msgprint({
							title: __("No Records"),
							message: __("No punch logs found for {0} between {1} and {2}.", [
								m.employee_name, m.date_from, m.date_to,
							]),
							indicator: "orange",
						});
						return;
					}
					let rows = m.days.map(d =>
						`<tr>
							<td>${d.punch_date}</td>
							<td>${frappe.datetime.str_to_user(d.first_punch)}</td>
							<td>${frappe.datetime.str_to_user(d.last_punch)}</td>
							<td>${d.total_punches}</td>
							<td>${d.checkins_created}</td>
						</tr>`
					).join("");
					frappe.msgprint({
						title: __("Punch Summary — {0} ({1} to {2})", [m.employee_name, m.date_from, m.date_to]),
						message: `
							<p>${__("Days present: {0} &nbsp;|&nbsp; Total punches: {1}", [m.days_present, m.total_punches])}</p>
							<table class="table table-bordered table-condensed" style="font-size:12px">
								<thead>
									<tr>
										<th>${__("Date")}</th>
										<th>${__("First Punch")}</th>
										<th>${__("Last Punch")}</th>
										<th>${__("Punches")}</th>
										<th>${__("Checkins")}</th>
									</tr>
								</thead>
								<tbody>${rows}</tbody>
							</table>`,
						indicator: "blue",
					});
				},
			});
		},
	});
	d.show();
}
