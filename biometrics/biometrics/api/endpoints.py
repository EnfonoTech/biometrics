# Copyright (c) 2026, Siva and contributors
# For license information, please see license.txt

"""
Whitelisted API endpoints for Biometrics integration.
These can be called from the frontend or external systems.
"""

import frappe

# Push/write-to-machine functions have been intentionally removed.
# This app is read-only from the Biometrics machine perspective:
# data flows FROM the machine INTO ERPNext, never the other direction.


@frappe.whitelist()
def get_biometrics_dashboard_data():
	"""Get summary data for Biometrics dashboard"""
	total_active = frappe.db.count("Employee", {"status": "Active"})
	with_device_id = frappe.db.count(
		"Employee", {"status": "Active", "attendance_device_id": ["is", "set"]}
	)

	data = {
		"devices": {
			"total": frappe.db.count("Biometrics Device"),
			"online": frappe.db.count("Biometrics Device", {"status": "Online"}),
			"offline": frappe.db.count("Biometrics Device", {"status": "Offline"}),
		},
		"employees": {
			"total_active": total_active,
			"with_attendance_device_id": with_device_id,
			"missing_attendance_device_id": total_active - with_device_id,
		},
		"transactions": {
			"total": frappe.db.count("Biometrics Transaction Log"),
			"with_checkin": frappe.db.count("Biometrics Transaction Log", {"checkin_created": 1}),
			"without_checkin": frappe.db.count("Biometrics Transaction Log", {"checkin_created": 0}),
		},
		"departments": frappe.db.count("Biometrics Department"),
		"areas": frappe.db.count("Biometrics Area"),
		"positions": frappe.db.count("Biometrics Position"),
	}

	# Last sync info
	settings = frappe.get_single("Biometrics Settings")
	data["last_sync"] = settings.last_sync_time
	data["last_transaction_sync"] = settings.last_transaction_sync
	data["auto_sync_enabled"] = settings.enable_auto_sync

	# Recent sync logs
	data["recent_syncs"] = frappe.get_all(
		"Biometrics Sync Log",
		fields=["name", "sync_type", "status", "started_at", "total_records", "checkins_created"],
		order_by="creation desc",
		limit=5,
	)

	return data


@frappe.whitelist()
def get_employees_missing_device_id():
	"""Return active ERPNext employees who have no attendance_device_id set."""
	return frappe.get_all(
		"Employee",
		filters={"status": "Active", "attendance_device_id": ["is", "not set"]},
		fields=["name", "employee_name", "department", "designation"],
		order_by="employee_name asc",
	)


@frappe.whitelist()
def sync_employee_logs(employee, date_from, date_to):
	"""Pull and store transaction logs for one specific ERPNext employee within a
	date range. Safe to call multiple times — duplicates are detected and skipped.

	Args:
		employee: ERPNext Employee ID (e.g. "HR-EMP-00001")
		date_from: Start date string "YYYY-MM-DD"
		date_to:   End date string   "YYYY-MM-DD"
	"""
	from biometrics.biometrics.api.client import BiometricsClient
	from biometrics.biometrics.api.sync import _create_employee_checkin
	from frappe.utils import cstr

	emp_row = frappe.db.get_value(
		"Employee", employee, ["attendance_device_id", "employee_name"], as_dict=True
	)
	if not emp_row:
		frappe.throw(f"Employee {employee} not found.")
	if not emp_row.attendance_device_id:
		frappe.throw(
			f"Employee {employee} has no Attendance Device ID. "
			"Set it on the Employee record before syncing."
		)

	emp_code = emp_row.attendance_device_id
	employee_name = emp_row.employee_name
	settings = frappe.get_single("Biometrics Settings")
	client = BiometricsClient()

	transactions = client.get_transactions(
		emp_code=emp_code,
		start_time=f"{date_from} 00:00:00",
		end_time=f"{date_to} 23:59:59",
	)

	created = 0
	skipped = 0
	checkins = 0
	errors = []

	for txn in transactions:
		try:
			txn_id = txn.get("id")
			punch_time = txn.get("punch_time")

			if not punch_time:
				skipped += 1
				continue

			# Skip if already imported by Biometrics transaction ID
			if txn_id and frappe.db.exists(
				"Biometrics Transaction Log", {"biometrics_transaction_id": txn_id}
			):
				skipped += 1
				continue

			# Skip duplicate by emp_code + punch_time
			if frappe.db.exists(
				"Biometrics Transaction Log",
				{"emp_code": emp_code, "punch_time": punch_time},
			):
				skipped += 1
				continue

			log = frappe.new_doc("Biometrics Transaction Log")
			log.biometrics_transaction_id = txn_id
			log.emp_code = emp_code
			log.punch_time = punch_time
			log.punch_state = cstr(txn.get("punch_state"))
			log.erpnext_employee = employee
			log.employee_name = employee_name
			log.device_sn = txn.get("terminal_sn")
			log.device_alias = txn.get("terminal_alias")
			log.area_alias = txn.get("area_alias")
			log.verify_type = txn.get("verify_type")
			log.work_code = txn.get("work_code")
			log.source = txn.get("source")
			log.purpose = txn.get("purpose")
			log.is_attendance = txn.get("is_attendance", 1)
			log.latitude = txn.get("latitude")
			log.longitude = txn.get("longitude")
			log.gps_location = txn.get("gps_location")
			log.mobile = txn.get("mobile")
			log.upload_time = txn.get("upload_time")
			log.sync_status = txn.get("sync_status")
			log.sync_time = txn.get("sync_time")

			# before_save maps punch_state → log_type
			log.insert(ignore_permissions=True)
			created += 1

			if settings.create_employee_checkin:
				try:
					if _create_employee_checkin(log):
						checkins += 1
				except Exception as e:
					log.error_message = str(e)
					log.save(ignore_permissions=True)

		except Exception as e:
			errors.append(f"Transaction {txn.get('id')}: {str(e)}")
			frappe.log_error(
				title=f"Biometrics Employee Log Sync Error: {employee}",
				message=str(e),
			)

	frappe.db.commit()

	return {
		"employee": employee,
		"employee_name": employee_name,
		"emp_code": emp_code,
		"date_from": date_from,
		"date_to": date_to,
		"total_fetched": len(transactions),
		"created": created,
		"skipped": skipped,
		"checkins_created": checkins,
		"errors": errors,
	}


@frappe.whitelist()
def repair_employee_checkins(employee=None):
	"""Create missing Employee Checkin records for transaction logs that already
	have an ERPNext employee linked but no checkin yet.

	Args:
		employee: Optional ERPNext Employee ID to limit scope. If omitted, repairs all.
	"""
	from biometrics.biometrics.api.sync import _create_employee_checkin

	filters = {"checkin_created": 0, "erpnext_employee": ["is", "set"]}
	if employee:
		filters["erpnext_employee"] = employee

	logs = frappe.get_all(
		"Biometrics Transaction Log",
		filters=filters,
		fields=["name"],
		limit=2000,
	)

	created = 0
	skipped = 0
	failed = 0

	for log_ref in logs:
		try:
			log = frappe.get_doc("Biometrics Transaction Log", log_ref.name)
			if _create_employee_checkin(log):
				created += 1
			else:
				skipped += 1
		except Exception as e:
			failed += 1
			frappe.log_error(title=f"Repair Checkin Error: {log_ref.name}", message=str(e))

	frappe.db.commit()
	return {"total": len(logs), "created": created, "skipped": skipped, "failed": failed}


@frappe.whitelist()
def resync_date_range(date_from, date_to):
	"""Re-pull all transactions for a given date range for every ERPNext employee
	that has an attendance_device_id. Useful for recovering from a missed sync window.
	Duplicates are skipped automatically.
	"""
	frappe.enqueue(
		"biometrics.biometrics.api.endpoints._run_resync_date_range",
		queue="long",
		timeout=3600,
		date_from=date_from,
		date_to=date_to,
		enqueue_after_commit=True,
	)
	return {"message": f"Re-sync queued for {date_from} to {date_to}. Check Sync Log for progress."}


def _run_resync_date_range(date_from, date_to):
	"""Background worker for resync_date_range."""
	from biometrics.biometrics.api.sync import (
		_build_employee_map, _create_employee_checkin, _create_sync_log,
		_complete_sync_log, _fail_sync_log,
	)
	from biometrics.biometrics.api.client import BiometricsClient
	from frappe.utils import cstr, now_datetime

	sync_log = _create_sync_log("Transactions")

	try:
		sync_log.status = "In Progress"
		sync_log.save(ignore_permissions=True)
		frappe.db.commit()

		employee_map = _build_employee_map()
		if not employee_map:
			_fail_sync_log(sync_log, "No employees with attendance_device_id found.")
			return

		settings = frappe.get_single("Biometrics Settings")
		client = BiometricsClient()

		transactions = client.get_transactions(
			start_time=f"{date_from} 00:00:00",
			end_time=f"{date_to} 23:59:59",
		)

		created = 0
		skipped_no_emp = 0
		skipped_dup = 0
		checkins = 0
		failed = 0

		for txn in transactions:
			try:
				emp_code = cstr(txn.get("emp_code"))
				punch_time = txn.get("punch_time")
				if not emp_code or not punch_time:
					skipped_no_emp += 1
					continue

				emp_info = employee_map.get(emp_code)
				if not emp_info:
					skipped_no_emp += 1
					continue

				txn_id = txn.get("id")
				if txn_id and frappe.db.exists(
					"Biometrics Transaction Log", {"biometrics_transaction_id": txn_id}
				):
					skipped_dup += 1
					continue

				if frappe.db.exists(
					"Biometrics Transaction Log",
					{"emp_code": emp_code, "punch_time": punch_time},
				):
					skipped_dup += 1
					continue

				log = frappe.new_doc("Biometrics Transaction Log")
				log.biometrics_transaction_id = txn_id
				log.emp_code = emp_code
				log.punch_time = punch_time
				log.punch_state = cstr(txn.get("punch_state"))
				log.erpnext_employee = emp_info["name"]
				log.employee_name = emp_info["employee_name"]
				log.device_sn = txn.get("terminal_sn")
				log.device_alias = txn.get("terminal_alias")
				log.area_alias = txn.get("area_alias")
				log.verify_type = txn.get("verify_type")
				log.work_code = txn.get("work_code")
				log.source = txn.get("source")
				log.purpose = txn.get("purpose")
				log.is_attendance = txn.get("is_attendance", 1)
				log.latitude = txn.get("latitude")
				log.longitude = txn.get("longitude")
				log.gps_location = txn.get("gps_location")
				log.mobile = txn.get("mobile")
				log.upload_time = txn.get("upload_time")
				log.sync_status = txn.get("sync_status")
				log.sync_time = txn.get("sync_time")
				log.insert(ignore_permissions=True)
				created += 1

				if settings.create_employee_checkin:
					try:
						if _create_employee_checkin(log):
							checkins += 1
					except Exception as e:
						log.error_message = str(e)
						log.save(ignore_permissions=True)

			except Exception as e:
				failed += 1
				frappe.log_error(
					title=f"Biometrics Re-sync Error: {txn.get('id')}",
					message=str(e),
				)

			if (created + skipped_dup + skipped_no_emp + failed) % 100 == 0:
				frappe.db.commit()

		frappe.db.commit()

		sync_log.reload()
		sync_log.status = "Completed" if failed == 0 else "Partially Failed"
		sync_log.total_records = len(transactions)
		sync_log.records_created = created
		sync_log.records_failed = failed
		sync_log.checkins_created = checkins
		sync_log.log_details = (
			f"Date range: {date_from} to {date_to}\n"
			f"Total fetched: {len(transactions)}\n"
			f"Created: {created}\n"
			f"Skipped (not in site): {skipped_no_emp}\n"
			f"Skipped (duplicate): {skipped_dup}\n"
			f"Checkins created: {checkins}\n"
			f"Failed: {failed}"
		)
		_complete_sync_log(sync_log)

	except Exception as e:
		_fail_sync_log(sync_log, str(e))
		frappe.log_error(title="Biometrics Date Range Re-sync Failed", message=str(e))


@frappe.whitelist()
def get_employee_punch_summary(employee, date_from, date_to):
	"""Return a day-by-day punch summary for an employee from stored transaction logs.
	Useful for attendance review without re-calling the Biometrics API.
	"""
	emp_code = frappe.db.get_value("Employee", employee, "attendance_device_id")
	if not emp_code:
		frappe.throw(f"Employee {employee} has no Attendance Device ID.")

	logs = frappe.db.sql(
		"""
		SELECT
			DATE(punch_time)  AS punch_date,
			MIN(punch_time)   AS first_punch,
			MAX(punch_time)   AS last_punch,
			COUNT(*)          AS total_punches,
			SUM(checkin_created) AS checkins_created
		FROM `tabBiometrics Transaction Log`
		WHERE
			emp_code = %(emp_code)s
			AND punch_time BETWEEN %(date_from)s AND %(date_to)s
		GROUP BY DATE(punch_time)
		ORDER BY punch_date ASC
		""",
		{
			"emp_code": emp_code,
			"date_from": f"{date_from} 00:00:00",
			"date_to": f"{date_to} 23:59:59",
		},
		as_dict=True,
	)

	return {
		"employee": employee,
		"employee_name": frappe.db.get_value("Employee", employee, "employee_name"),
		"emp_code": emp_code,
		"date_from": date_from,
		"date_to": date_to,
		"days": logs,
		"total_punches": sum(d.total_punches for d in logs),
		"days_present": len(logs),
	}


@frappe.whitelist()
def run_auto_map_employees():
	"""Manually trigger auto-mapping of all unmapped Biometrics Employee records to ERPNext.
	Returns count of newly mapped records.
	"""
	from biometrics.biometrics.api.sync import _auto_map_all_biometrics_employees

	settings = frappe.get_single("Biometrics Settings")
	mapped = _auto_map_all_biometrics_employees(settings)
	frappe.db.commit()

	msg = f"Auto-map complete. {mapped} Biometrics Employee record(s) linked to ERPNext."
	frappe.msgprint(msg, alert=True)
	return {"mapped": mapped, "message": msg}
