// Copyright (c) 2026, Siva and contributors
// For license information, please see license.txt

// Employee Checkin calendar: one entry per employee per day showing the first check-in time, plus
// Absent / On Leave days. Events come from biometrics.biometrics.checkin_register, so "late" matches
// the Monthly Check-in Register report and the Check-in Heatmap.
frappe.views.calendar["Employee Checkin"] = {
	field_map: {
		id: "name",
		start: "start",
		end: "end",
		title: "title",
		allDay: "allDay",
		convertToUserTz: "convert_to_user_tz",
	},
	get_events_method: "biometrics.biometrics.checkin_register.get_calendar_events",
	get_css_class(data) {
		return (
			{
				ontime: "success",
				present: "default",
				late: "warning",
				absent: "danger",
				leave: "default",
			}[data.state] || "default"
		);
	},
	options: {
		editable: false,
		selectable: false,
		// absences and late arrivals first, then "08:02 Name" titles by time; a busy day collapses into "+N more"
		eventOrder: "rank,title",
		eventLimit: 6,
	},
};
