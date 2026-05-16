# Copyright (c) 2026, Siva and contributors
# For license information, please see license.txt

import frappe
from frappe.utils import nowdate, add_days, now_datetime, get_datetime


# ── helpers ──────────────────────────────────────────────────────────────────

def _get_shift_config():
	settings = frappe.get_single("Biometrics Settings")
	start = str(getattr(settings, "shift_start_time", None) or "08:00:00")[:5]
	end   = str(getattr(settings, "shift_end_time",   None) or "17:00:00")[:5]
	return start, end


# ── summary card data ────────────────────────────────────────────────────────

@frappe.whitelist()
def get_summary(date_from=None, date_to=None):
	today     = nowdate()
	date_from = date_from or today
	date_to   = date_to   or today

	total_active = frappe.db.count("Employee", {"status": "Active"})
	enrolled     = frappe.db.count("Employee", {"status": "Active", "attendance_device_id": ["is", "set"]})

	devices_total  = frappe.db.count("Biometrics Device")
	devices_online = frappe.db.count("Biometrics Device", {"status": "Online"})

	punch_range       = [f"{date_from} 00:00:00", f"{date_to} 23:59:59"]
	punches_period    = frappe.db.count("Biometrics Transaction Log", {"punch_time": ["between", punch_range]})
	checkins_period   = frappe.db.count("Biometrics Transaction Log", {"punch_time": ["between", punch_range], "checkin_created": 1})
	unmatched_period  = frappe.db.count("Biometrics Transaction Log", {"punch_time": ["between", punch_range], "erpnext_employee": ["is", "not set"]})

	last_sync = frappe.db.get_value("Biometrics Sync Log", {"status": "Completed"}, "completed_at", order_by="completed_at desc")
	settings  = frappe.get_single("Biometrics Settings")

	shift_start, shift_end = _get_shift_config()

	return {
		"enrolled":             enrolled,
		"not_enrolled":         total_active - enrolled,
		"total_active":         total_active,
		"devices_total":        devices_total,
		"devices_online":       devices_online,
		"devices_offline":      devices_total - devices_online,
		"punches_period":       punches_period,
		"checkins_period":      checkins_period,
		"unmatched_period":     unmatched_period,
		"last_sync":            str(last_sync) if last_sync else None,
		"auto_sync":            settings.enable_auto_sync,
		"last_transaction_sync": str(settings.last_transaction_sync) if settings.last_transaction_sync else None,
		"shift_start":          shift_start,
		"shift_end":            shift_end,
	}


# ── punch trend (7-day bar) ──────────────────────────────────────────────────

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


# ── hourly heatmap ───────────────────────────────────────────────────────────

@frappe.whitelist()
def get_hourly_heatmap(date_from=None, date_to=None):
	today     = nowdate()
	date_from = date_from or today
	date_to   = date_to   or today
	return frappe.db.sql(
		"""
		SELECT HOUR(punch_time) AS hour_of_day, COUNT(*) AS punch_count
		FROM `tabBiometrics Transaction Log`
		WHERE punch_time BETWEEN %(date_from)s AND %(date_to)s
		GROUP BY HOUR(punch_time)
		ORDER BY hour_of_day ASC
		""",
		{"date_from": f"{date_from} 00:00:00", "date_to": f"{date_to} 23:59:59"},
		as_dict=True,
	)


# ── employee IN/OUT (features 1, 3, 7) ──────────────────────────────────────

@frappe.whitelist()
def get_employee_inout(date_from=None, date_to=None, department=None, employee=None):
	"""Returns IN/OUT status for every enrolled employee with working hours,
	late-arrival flag, and early-departure flag.
	"""
	today     = nowdate()
	date_from = date_from or today
	date_to   = date_to   or today

	shift_start, shift_end = _get_shift_config()

	emp_filters = {"status": "Active", "attendance_device_id": ["is", "set"]}
	if employee:
		emp_filters["name"] = employee
	if department:
		emp_filters["department"] = department

	employees = frappe.get_all(
		"Employee",
		filters=emp_filters,
		fields=["name", "employee_name", "department", "designation", "attendance_device_id"],
		order_by="employee_name asc",
	)
	if not employees:
		return {"rows": [], "shift_start": shift_start, "shift_end": shift_end}

	emp_names = [e.name for e in employees]

	logs = frappe.db.sql(
		"""
		SELECT
			erpnext_employee,
			MIN(punch_time)                                              AS first_punch,
			MAX(punch_time)                                              AS last_punch,
			MIN(CASE WHEN log_type = 'IN'  THEN punch_time END)         AS first_in,
			MAX(CASE WHEN log_type = 'IN'  THEN punch_time END)         AS last_in,
			MAX(CASE WHEN log_type = 'OUT' THEN punch_time END)         AS last_out,
			COUNT(*)                                                     AS total_punches,
			SUM(checkin_created)                                         AS checkins_created
		FROM `tabBiometrics Transaction Log`
		WHERE erpnext_employee IN %(emp_names)s
		  AND punch_time BETWEEN %(date_from)s AND %(date_to)s
		GROUP BY erpnext_employee
		""",
		{
			"emp_names": emp_names,
			"date_from": f"{date_from} 00:00:00",
			"date_to":   f"{date_to} 23:59:59",
		},
		as_dict=True,
	)

	log_map = {l.erpnext_employee: l for l in logs}

	result = []
	for emp in employees:
		log = log_map.get(emp.name)

		first_punch = log.first_punch if log else None
		last_punch  = log.last_punch  if log else None
		first_in    = log.first_in    if log else None
		last_out    = log.last_out    if log else None

		# Working hours: first IN → last OUT (or first/last punch if IN/OUT not distinct)
		working_minutes = None
		start_dt = first_in   or first_punch
		end_dt   = last_out   or last_punch
		if start_dt and end_dt and start_dt != end_dt:
			delta = (end_dt - start_dt).total_seconds()
			working_minutes = max(0, int(delta // 60))

		# Late arrival: first IN after shift_start
		is_late = False
		if first_in:
			is_late = str(first_in)[11:16] > shift_start

		# Left early: last OUT before shift_end (only flag if OUT exists)
		left_early = False
		if last_out:
			left_early = str(last_out)[11:16] < shift_end

		# Missing punch: came in but no OUT recorded
		missing_out = bool(first_in and not last_out)

		result.append({
			"employee":             emp.name,
			"employee_name":        emp.employee_name,
			"department":           emp.department or "",
			"designation":          emp.designation or "",
			"attendance_device_id": emp.attendance_device_id,
			"first_punch":          str(first_punch) if first_punch else None,
			"last_punch":           str(last_punch)  if last_punch  else None,
			"first_in":             str(first_in)    if first_in    else None,
			"last_out":             str(last_out)    if last_out    else None,
			"total_punches":        log.total_punches    if log else 0,
			"checkins_created":     log.checkins_created if log else 0,
			"working_minutes":      working_minutes,
			"is_late":              is_late,
			"left_early":           left_early,
			"missing_out":          missing_out,
			"status":               "Present" if log else "Absent",
		})

	return {"rows": result, "shift_start": shift_start, "shift_end": shift_end}


# ── today attendance (used by summary widget) ────────────────────────────────

@frappe.whitelist()
def get_today_attendance(date_from=None, date_to=None, employee=None, department=None):
	today     = nowdate()
	date_from = date_from or today
	date_to   = date_to   or today

	conditions = ["tl.punch_time BETWEEN %(date_from)s AND %(date_to)s"]
	params     = {"date_from": f"{date_from} 00:00:00", "date_to": f"{date_to} 23:59:59"}

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
			tl.erpnext_employee AS employee,
			tl.employee_name,
			e.department,
			e.designation,
			MIN(tl.punch_time)                                         AS first_punch,
			MAX(tl.punch_time)                                         AS last_punch,
			COUNT(*)                                                   AS total_punches,
			SUM(tl.checkin_created)                                    AS checkins_created,
			MAX(CASE WHEN tl.log_type='IN'  THEN tl.punch_time END)   AS last_in,
			MAX(CASE WHEN tl.log_type='OUT' THEN tl.punch_time END)   AS last_out
		FROM `tabBiometrics Transaction Log` tl
		LEFT JOIN `tabEmployee` e ON e.name = tl.erpnext_employee
		WHERE {where}
		  AND tl.erpnext_employee IS NOT NULL AND tl.erpnext_employee != ''
		GROUP BY tl.erpnext_employee, tl.employee_name, e.department, e.designation
		ORDER BY first_punch ASC
		""",
		params,
		as_dict=True,
	)


# ── recent transactions ──────────────────────────────────────────────────────

@frappe.whitelist()
def get_recent_transactions(date_from=None, date_to=None, employee=None, department=None, limit=100):
	today     = nowdate()
	date_from = date_from or today
	date_to   = date_to   or today

	conditions = ["tl.punch_time BETWEEN %(date_from)s AND %(date_to)s"]
	params     = {"date_from": f"{date_from} 00:00:00", "date_to": f"{date_to} 23:59:59", "limit": int(limit)}

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
			tl.name, tl.emp_code, tl.employee_name, tl.erpnext_employee,
			e.department, tl.punch_time, tl.log_type,
			tl.device_alias, tl.area_alias,
			tl.checkin_created, tl.employee_checkin, tl.error_message, tl.verify_type
		FROM `tabBiometrics Transaction Log` tl
		LEFT JOIN `tabEmployee` e ON e.name = tl.erpnext_employee
		WHERE {where}
		ORDER BY tl.punch_time DESC
		LIMIT %(limit)s
		""",
		params,
		as_dict=True,
	)


# ── monthly attendance summary (feature 8) ───────────────────────────────────

@frappe.whitelist()
def get_monthly_summary(year_month=None, department=None, employee=None):
	"""Per-employee monthly attendance: days present, avg working hours, attendance %."""
	import calendar
	from collections import defaultdict

	today      = nowdate()
	year_month = year_month or today[:7]
	year, month = int(year_month[:4]), int(year_month[5:7])
	days_in_month = calendar.monthrange(year, month)[1]
	date_from  = f"{year_month}-01"
	date_to    = f"{year_month}-{days_in_month:02d}"

	emp_filters = {"status": "Active", "attendance_device_id": ["is", "set"]}
	if employee:
		emp_filters["name"] = employee
	if department:
		emp_filters["department"] = department

	employees = frappe.get_all(
		"Employee",
		filters=emp_filters,
		fields=["name", "employee_name", "department", "designation"],
		order_by="employee_name asc",
	)
	if not employees:
		return {"rows": [], "year_month": year_month, "days_in_month": days_in_month}

	emp_names = [e.name for e in employees]

	# Daily first/last punch per employee per day
	daily = frappe.db.sql(
		"""
		SELECT
			erpnext_employee,
			DATE(punch_time) AS work_date,
			MIN(punch_time)  AS first_punch,
			MAX(punch_time)  AS last_punch,
			COUNT(*)         AS day_punches
		FROM `tabBiometrics Transaction Log`
		WHERE erpnext_employee IN %(emp_names)s
		  AND punch_time BETWEEN %(date_from)s AND %(date_to)s
		GROUP BY erpnext_employee, DATE(punch_time)
		""",
		{
			"emp_names": emp_names,
			"date_from": f"{date_from} 00:00:00",
			"date_to":   f"{date_to} 23:59:59",
		},
		as_dict=True,
	)

	daily_map = defaultdict(list)
	for row in daily:
		daily_map[row.erpnext_employee].append(row)

	result = []
	for emp in employees:
		days    = daily_map.get(emp.name, [])
		present = len(days)
		punches = sum(d.day_punches for d in days)

		# Average working hours per present day
		mins_list = []
		for d in days:
			if d.first_punch and d.last_punch and d.first_punch != d.last_punch:
				mins_list.append(int((d.last_punch - d.first_punch).total_seconds() // 60))

		avg_mins = int(sum(mins_list) / len(mins_list)) if mins_list else 0
		late_days = 0  # placeholder — would need shift_start per day

		result.append({
			"employee":           emp.name,
			"employee_name":      emp.employee_name,
			"department":         emp.department or "",
			"designation":        emp.designation or "",
			"days_present":       present,
			"days_absent":        days_in_month - present,
			"attendance_pct":     round((present / days_in_month) * 100) if days_in_month else 0,
			"total_punches":      punches,
			"avg_working_hours":  f"{avg_mins // 60}h {avg_mins % 60:02d}m" if avg_mins else "—",
			"avg_working_minutes": avg_mins,
		})

	return {"rows": result, "year_month": year_month, "days_in_month": days_in_month}


# ── device offline alerts (feature 9) ────────────────────────────────────────

@frappe.whitelist()
def get_device_alerts():
	settings        = frappe.get_single("Biometrics Settings")
	threshold_hours = int(getattr(settings, "device_offline_alert_hours", 0) or 2)

	devices = frappe.get_all(
		"Biometrics Device",
		fields=["name", "alias", "serial_number", "ip_address", "status", "last_activity", "last_sync"],
	)

	alerts = []
	now = now_datetime()
	for d in devices:
		last_seen = d.last_activity or d.last_sync
		if not last_seen:
			alerts.append({
				"device":      d.alias or d.serial_number,
				"serial":      d.serial_number,
				"ip":          d.ip_address or "—",
				"status":      d.status,
				"hours_since": None,
				"message":     "Never synced",
				"severity":    "high",
			})
		else:
			hours_since = (now - get_datetime(last_seen)).total_seconds() / 3600
			if hours_since > threshold_hours:
				alerts.append({
					"device":      d.alias or d.serial_number,
					"serial":      d.serial_number,
					"ip":          d.ip_address or "—",
					"status":      d.status,
					"hours_since": round(hours_since, 1),
					"message":     f"No activity for {round(hours_since, 1)}h",
					"severity":    "high" if hours_since > 24 else "medium",
				})

	return {"alerts": alerts, "threshold_hours": threshold_hours}


# ── quick sync trigger from dashboard (feature 4) ────────────────────────────

@frappe.whitelist()
def trigger_sync():
	from biometrics.biometrics.api.sync import sync_transactions
	frappe.enqueue(sync_transactions, queue="long", timeout=1800, enqueue_after_commit=True)
	return {"message": "Transaction sync queued. Data will update in a moment."}


# ── employee punch summary (used by Employee form button) ─────────────────────

@frappe.whitelist()
def get_employee_punch_summary(employee, date_from, date_to):
	emp_code = frappe.db.get_value("Employee", employee, "attendance_device_id")
	if not emp_code:
		frappe.throw(f"Employee {employee} has no Attendance Device ID.")

	logs = frappe.db.sql(
		"""
		SELECT
			DATE(punch_time)   AS punch_date,
			MIN(punch_time)    AS first_punch,
			MAX(punch_time)    AS last_punch,
			COUNT(*)           AS total_punches,
			SUM(checkin_created) AS checkins_created
		FROM `tabBiometrics Transaction Log`
		WHERE emp_code = %(emp_code)s
		  AND punch_time BETWEEN %(date_from)s AND %(date_to)s
		GROUP BY DATE(punch_time)
		ORDER BY punch_date ASC
		""",
		{
			"emp_code":  emp_code,
			"date_from": f"{date_from} 00:00:00",
			"date_to":   f"{date_to} 23:59:59",
		},
		as_dict=True,
	)

	return {
		"employee":      employee,
		"employee_name": frappe.db.get_value("Employee", employee, "employee_name"),
		"emp_code":      emp_code,
		"date_from":     date_from,
		"date_to":       date_to,
		"days":          logs,
		"total_punches": sum(d.total_punches for d in logs),
		"days_present":  len(logs),
	}
