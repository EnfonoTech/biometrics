// Copyright (c) 2026, Siva and contributors
// For license information, please see license.txt

frappe.ui.form.on("Biometrics Settings", {
	refresh(frm) {
		// Test Connection button
		frm.add_custom_button(__("Test Connection"), function () {
			frappe.call({
				method: "test_connection",
				doc: frm.doc,
				freeze: true,
				freeze_message: __("Testing connection to Biometrics server..."),
				callback: function (r) {
					if (r.message && r.message.success) {
						frappe.msgprint({
							title: __("Success"),
							message: r.message.message,
							indicator: "green",
						});
					} else {
						frappe.msgprint({
							title: __("Connection Failed"),
							message: r.message
								? r.message.message
								: "Unknown error",
							indicator: "red",
						});
					}
					frm.reload_doc();
				},
			});
		}, __("Connection"));

		// Full Sync button
		frm.add_custom_button(__("Full Sync Now"), function () {
			frappe.confirm(
				__(
					"This will sync all data from Biometrics (devices, employees, departments, areas, positions, transactions). Continue?"
				),
				function () {
					frappe.call({
						method: "full_sync",
						doc: frm.doc,
						freeze: true,
						freeze_message: __("Queuing full sync..."),
						callback: function (r) {
							frappe.msgprint(r.message.message);
						},
					});
				}
			);
		}, __("Sync"));

		// Sync Transactions button
		frm.add_custom_button(__("Sync Transactions"), function () {
			frappe.call({
				method: "sync_transactions",
				doc: frm.doc,
				freeze: true,
				freeze_message: __("Queuing transaction sync..."),
				callback: function (r) {
					frappe.msgprint(r.message.message);
				},
			});
		}, __("Sync"));

		// Individual entity sync buttons
		["Devices", "Employees", "Departments", "Areas", "Positions"].forEach(
			function (entity) {
				frm.add_custom_button(
					__("Sync " + entity),
					function () {
						frappe.call({
							method: "sync_entity",
							doc: frm.doc,
							args: { entity: entity.toLowerCase() },
							freeze: true,
							freeze_message: __("Queuing " + entity.toLowerCase() + " sync..."),
							callback: function (r) {
								frappe.msgprint(r.message.message);
							},
						});
					},
					__("Sync")
				);
			}
		);

		// Shortcut links
		frm.add_custom_button(__("View Sync Logs"), function () {
			frappe.set_route("List", "Biometrics Sync Log");
		}, __("View"));

		frm.add_custom_button(__("View Devices"), function () {
			frappe.set_route("List", "Biometrics Device");
		}, __("View"));

		frm.add_custom_button(__("View Employees"), function () {
			frappe.set_route("List", "Biometrics Employee");
		}, __("View"));

		frm.add_custom_button(__("View Transaction Logs"), function () {
			frappe.set_route("List", "Biometrics Transaction Log");
		}, __("View"));

		frm.add_custom_button(__("Employees Missing Device ID"), function () {
			frappe.call({
				method: "biometrics.biometrics.api.endpoints.get_employees_missing_device_id",
				freeze: true,
				freeze_message: __("Checking employees..."),
				callback: function (r) {
					if (!r.message || !r.message.length) {
						frappe.msgprint({
							title: __("All Set"),
							message: __("All active employees have an Attendance Device ID."),
							indicator: "green",
						});
						return;
					}
					let rows = r.message.map(e =>
						`<tr><td>${e.name}</td><td>${e.employee_name}</td><td>${e.department || ""}</td><td>${e.designation || ""}</td></tr>`
					).join("");
					frappe.msgprint({
						title: __("{0} Employee(s) Missing Attendance Device ID", [r.message.length]),
						message: `<table class="table table-bordered table-condensed">
							<thead><tr><th>ID</th><th>Name</th><th>Department</th><th>Designation</th></tr></thead>
							<tbody>${rows}</tbody></table>`,
						indicator: "orange",
					});
				},
			});
		}, __("View"));

		frm.add_custom_button(__("Validate Transaction Logs"), function () {
			frappe.confirm(
				__(
					"This will find all transaction logs without an ERPNext Employee, look up the Biometrics Employee mapping, backfill the employee, and create missing Employee Checkins. Continue?"
				),
				function () {
					frappe.call({
						method: "biometrics.biometrics.doctype.biometrics_employee.biometrics_employee.bulk_validate_transaction_logs",
						freeze: true,
						freeze_message: __("Validating transaction logs..."),
						callback: function (r) {
							if (r.message) {
								let msg = r.message;
								let details = __("Updated: {0} log(s)", [msg.total_updated])
									+ "<br>" + __("Checkins Created: {0}", [msg.total_checkins]);
								if (msg.skipped_emp_codes && msg.skipped_emp_codes.length) {
									details += "<br><br>" + __("Skipped employee codes (no mapping): {0}",
										[msg.skipped_emp_codes.join(", ")]);
								}
								frappe.msgprint({
									title: __("Bulk Validation Complete"),
									message: details,
									indicator: msg.total_updated > 0 ? "green" : "blue",
								});
							}
						},
					});
				}
			);
		}, __("Sync"));

		// ── Utilities ─────────────────────────────────────────────────────────

		frm.add_custom_button(__("Sync Logs for Employee"), function () {
			_show_employee_sync_dialog();
		}, __("Utilities"));

		frm.add_custom_button(__("Re-sync Date Range"), function () {
			_show_date_range_resync_dialog();
		}, __("Utilities"));

		frm.add_custom_button(__("Repair All Missing Checkins"), function () {
			frappe.confirm(
				__("This will create Employee Checkin records for every transaction log that has an ERPNext employee but no checkin yet (up to 2,000 records per run). Continue?"),
				function () {
					frappe.call({
						method: "biometrics.biometrics.api.endpoints.repair_employee_checkins",
						freeze: true,
						freeze_message: __("Repairing checkins..."),
						callback: function (r) {
							if (r.message) {
								let m = r.message;
								frappe.msgprint({
									title: __("Repair Complete"),
									message: __(
										"Total logs processed: {0}<br>Checkins created: {1}<br>Already existed: {2}<br>Failed: {3}",
										[m.total, m.created, m.skipped, m.failed]
									),
									indicator: m.created > 0 ? "green" : "blue",
								});
							}
						},
					});
				}
			);
		}, __("Utilities"));
	},
});


function _show_employee_sync_dialog() {
	let today = frappe.datetime.get_today();
	let week_ago = frappe.datetime.add_days(today, -7);

	let d = new frappe.ui.Dialog({
		title: __("Sync Attendance Logs for a Specific Employee"),
		fields: [
			{
				label: __("Employee"),
				fieldname: "employee",
				fieldtype: "Link",
				options: "Employee",
				filters: { status: "Active" },
				reqd: 1,
			},
			{ fieldtype: "Column Break" },
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
					Fetches punch records from the Biometrics machine for the selected employee
					within the date range. Existing records are never duplicated.
				</p>`,
			},
		],
		primary_action_label: __("Sync Now"),
		primary_action(values) {
			d.hide();
			frappe.call({
				method: "biometrics.biometrics.api.endpoints.sync_employee_logs",
				args: {
					employee: values.employee,
					date_from: values.date_from,
					date_to: values.date_to,
				},
				freeze: true,
				freeze_message: __("Fetching logs from Biometrics machine..."),
				callback: function (r) {
					if (!r.message) return;
					let m = r.message;
					let errHtml = m.errors && m.errors.length
						? `<br><b>${__("Errors")}:</b><br>${m.errors.join("<br>")}`
						: "";
					frappe.msgprint({
						title: __("Sync Complete — {0}", [m.employee_name]),
						message: [
							__("Period: {0} → {1}", [m.date_from, m.date_to]),
							__("Device ID (emp_code): {0}", [m.emp_code]),
							__("Fetched from machine: {0}", [m.total_fetched]),
							__("New logs created: {0}", [m.created]),
							__("Skipped (already exist): {0}", [m.skipped]),
							__("Employee Checkins created: {0}", [m.checkins_created]),
							errHtml,
						].join("<br>"),
						indicator: m.created > 0 ? "green" : "blue",
					});
				},
			});
		},
	});
	d.show();
}


function _show_date_range_resync_dialog() {
	let today = frappe.datetime.get_today();
	let week_ago = frappe.datetime.add_days(today, -7);

	let d = new frappe.ui.Dialog({
		title: __("Re-sync All Employee Logs for a Date Range"),
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
					Re-pulls transactions for <b>all</b> ERPNext employees (with attendance_device_id)
					within the chosen period. Existing records are skipped — no duplicates are created.
					Runs as a background job; check <b>Biometrics Sync Log</b> for progress.
				</p>`,
			},
		],
		primary_action_label: __("Queue Re-sync"),
		primary_action(values) {
			d.hide();
			frappe.call({
				method: "biometrics.biometrics.api.endpoints.resync_date_range",
				args: {
					date_from: values.date_from,
					date_to: values.date_to,
				},
				freeze: true,
				freeze_message: __("Queuing re-sync job..."),
				callback: function (r) {
					if (r.message) {
						frappe.msgprint({ message: r.message.message, indicator: "blue" });
					}
				},
			});
		},
	});
	d.show();
}
