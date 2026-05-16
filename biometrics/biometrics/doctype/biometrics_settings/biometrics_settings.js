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
	},
});
