# Copyright (c) 2026, Siva and contributors
# For license information, please see license.txt

import frappe
from frappe.utils import nowdate, add_days


@frappe.whitelist()
def get_summary(date_from=None, date_to=None):
	today = nowdate()
	date_from = date_from or today
	date_to = date_to or today

	total_active = frappe.db.count("Employee", {"status": "Active"})
	enrolled = frappe.db.count(
		"Employee", {"status": "Active", "attendance_device_id": ["is", "set"]}
	)

	devices_total = frappe.db.count("Biometrics Device")
	devices_online = frappe.db.count("Biometrics Device", {"status": "Online"})

	punch_range = [f"{date_from} 00:00:00", f"{date_to} 23:59:59"]
	punches_period = frappe.db.count(
		"Biometrics Transaction Log", {"punch_time": ["between", punch_range]}
	)
	checkins_period = frappe.db.count(
		"Biometrics Transaction Log",
		{"punch_time": ["between", punch_range], "checkin_created": 1},
	)
	unmatched_period = frappe.db.count(
		"Biometrics Transaction Log",
		{
			"punch_time": ["between", punch_range],
			"erpnext_employee": ["is", "not set"],
		},
	)

	last_sync = frappe.db.get_value(
		"Biometrics Sync Log",
		{"status": "Completed"},
		"completed_at",
		order_by="completed_at desc",
	)

	settings = frappe.get_single("Biometrics Settings")

	return {
		"enrolled": enrolled,
		"not_enrolled": total_active - enrolled,
		"total_active": total_active,
		"devices_total": devices_total,
		"devices_online": devices_online,
		"devices_offline": devices_total - devices_online,
		"punches_period": punches_period,
		"checkins_period": checkins_period,
		"unmatched_period": unmatched_period,
		"last_sync": str(last_sync) if last_sync else None,
		"auto_sync": settings.enable_auto_sync,
		"last_transaction_sync": str(settings.last_transaction_sync) if settings.last_transaction_sync else None,
	}


@frappe.whitelist()
def get_punch_trend(days=7):
	from_date = add_days(nowdate(), -(int(days) - 1))

	return frappe.db.sql(
		"""
		SELECT
			DATE(punch_time)         AS punch_date,
			COUNT(*)                 AS punch_count,
			SUM(checkin_created)     AS checkin_count,
			COUNT(DISTINCT emp_code) AS employee_count
		FROM `tabBiometrics Transaction Log`
		WHERE DATE(punch_time) >= %(from_date)s
		GROUP BY DATE(punch_time)
		ORDER BY punch_date ASC
		""",
		{"from_date": from_date},
		as_dict=True,
	)


@frappe.whitelist()
def get_today_attendance(date_from=None, date_to=None, employee=None, department=None):
	today = nowdate()
	date_from = date_from or today
	date_to = date_to or today

	conditions = ["tl.punch_time BETWEEN %(date_from)s AND %(date_to)s"]
	params = {
		"date_from": f"{date_from} 00:00:00",
		"date_to": f"{date_to} 23:59:59",
	}

	if employee:
		conditions.append("tl.erpnext_employee = %(employee)s")
		params["employee"] = employee

	if department:
		conditions.append("e.department = %(department)s")
		params["department"] = department

	where = " AND ".join(conditions)

	return frappe.db.sql(
		f"""
		SELECT
			tl.erpnext_employee                                            AS employee,
			tl.employee_name,
			e.department,
			e.designation,
			MIN(tl.punch_time)                                             AS first_punch,
			MAX(tl.punch_time)                                             AS last_punch,
			COUNT(*)                                                       AS total_punches,
			SUM(tl.checkin_created)                                        AS checkins_created,
			MAX(CASE WHEN tl.log_type = 'IN'  THEN tl.punch_time END)     AS last_in,
			MAX(CASE WHEN tl.log_type = 'OUT' THEN tl.punch_time END)     AS last_out
		FROM `tabBiometrics Transaction Log` tl
		LEFT JOIN `tabEmployee` e ON e.name = tl.erpnext_employee
		WHERE {where}
		  AND tl.erpnext_employee IS NOT NULL
		  AND tl.erpnext_employee != ''
		GROUP BY tl.erpnext_employee, tl.employee_name, e.department, e.designation
		ORDER BY first_punch ASC
		""",
		params,
		as_dict=True,
	)


@frappe.whitelist()
def get_recent_transactions(date_from=None, date_to=None, employee=None, department=None, limit=100):
	today = nowdate()
	date_from = date_from or today
	date_to = date_to or today

	conditions = ["tl.punch_time BETWEEN %(date_from)s AND %(date_to)s"]
	params = {
		"date_from": f"{date_from} 00:00:00",
		"date_to": f"{date_to} 23:59:59",
		"limit": int(limit),
	}

	if employee:
		conditions.append("tl.erpnext_employee = %(employee)s")
		params["employee"] = employee

	if department:
		conditions.append("e.department = %(department)s")
		params["department"] = department

	where = " AND ".join(conditions)

	return frappe.db.sql(
		f"""
		SELECT
			tl.name,
			tl.emp_code,
			tl.employee_name,
			tl.erpnext_employee,
			e.department,
			tl.punch_time,
			tl.log_type,
			tl.device_alias,
			tl.area_alias,
			tl.checkin_created,
			tl.employee_checkin,
			tl.error_message,
			tl.verify_type
		FROM `tabBiometrics Transaction Log` tl
		LEFT JOIN `tabEmployee` e ON e.name = tl.erpnext_employee
		WHERE {where}
		ORDER BY tl.punch_time DESC
		LIMIT %(limit)s
		""",
		params,
		as_dict=True,
	)


@frappe.whitelist()
def get_device_status():
	return frappe.get_all(
		"Biometrics Device",
		fields=[
			"name", "serial_number", "alias", "ip_address", "status",
			"area_name", "last_activity", "last_sync",
			"user_count", "transaction_count", "firmware_version",
		],
		order_by="status asc, alias asc",
	)


@frappe.whitelist()
def get_hourly_heatmap(date_from=None, date_to=None):
	"""Returns punch counts grouped by hour-of-day for the period."""
	today = nowdate()
	date_from = date_from or today
	date_to = date_to or today

	return frappe.db.sql(
		"""
		SELECT
			HOUR(punch_time) AS hour_of_day,
			COUNT(*)         AS punch_count
		FROM `tabBiometrics Transaction Log`
		WHERE punch_time BETWEEN %(date_from)s AND %(date_to)s
		GROUP BY HOUR(punch_time)
		ORDER BY hour_of_day ASC
		""",
		{"date_from": f"{date_from} 00:00:00", "date_to": f"{date_to} 23:59:59"},
		as_dict=True,
	)
