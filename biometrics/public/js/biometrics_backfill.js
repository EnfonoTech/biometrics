// Copyright (c) 2026, Siva and contributors
// For license information, please see license.txt

// "Backfill Biometric Punches" on the Attendance and Employee Checkin lists (HR Manager, System Manager).
// Re-reads punches from the biometrics server for a date range, imports the missing ones and,
// with "Override existing attendance", re-marks every day of the range from its check-ins.

frappe.provide("biometrics");

biometrics.open_backfill_dialog = function () {
	const today = frappe.datetime.get_today();
	const dialog = new frappe.ui.Dialog({
		title: __("Backfill Biometric Punches"),
		fields: [
			{
				fieldname: "from_date",
				label: __("From Date"),
				fieldtype: "Date",
				reqd: 1,
				default: frappe.datetime.add_days(today, -7),
			},
			{ fieldtype: "Column Break" },
			{
				fieldname: "to_date",
				label: __("To Date"),
				fieldtype: "Date",
				reqd: 1,
				default: today,
			},
			{ fieldtype: "Section Break" },
			{
				fieldname: "employees",
				label: __("Employees"),
				fieldtype: "MultiSelectList",
				description: __("Leave empty for every employee with an Attendance Device ID."),
				get_data: (txt) => frappe.db.get_link_options("Employee", txt, { status: "Active" }),
			},
			{
				fieldname: "override_attendance",
				label: __("Override existing attendance"),
				fieldtype: "Check",
				description: __(
					"Re-mark every day in the range that has check-ins, replacing the attendance already there (also attendance entered by hand) and marking days that have none. Attendance from a leave or an Attendance Request is never replaced."
				),
			},
		],
		primary_action_label: __("Start Backfill"),
		primary_action(values) {
			if (values.from_date > values.to_date) {
				frappe.msgprint(__("From Date must be on or before To Date."));
				return;
			}
			const run = () =>
				frappe
					.call({
						method: "biometrics.biometrics.api.sync.backfill_transactions",
						args: {
							from_date: values.from_date,
							to_date: values.to_date,
							employees: values.employees || [],
							override_attendance: values.override_attendance ? 1 : 0,
						},
						freeze: true,
					})
					.then((r) => {
						dialog.hide();
						frappe.msgprint({ title: __("Backfill Queued"), message: r.message, indicator: "green" });
					});

			if (values.override_attendance) {
				frappe.confirm(
					__(
						"Existing attendance from {0} to {1} will be cancelled and marked again from the check-ins. Continue?",
						[frappe.datetime.str_to_user(values.from_date), frappe.datetime.str_to_user(values.to_date)]
					),
					run
				);
			} else {
				run();
			}
		},
	});
	dialog.show();
};

// add the button without replacing the list settings HRMS already defines for these doctypes
["Attendance", "Employee Checkin"].forEach((doctype) => {
	const settings = (frappe.listview_settings[doctype] = frappe.listview_settings[doctype] || {});
	if (settings.__biometrics_backfill) return;
	settings.__biometrics_backfill = true;

	const onload = settings.onload;
	settings.onload = function (listview) {
		if (onload) onload.apply(this, arguments);
		if (frappe.user.has_role(["HR Manager", "System Manager"])) {
			listview.page.add_inner_button(__("Backfill Biometric Punches"), () =>
				biometrics.open_backfill_dialog()
			);
		}
	};
});
