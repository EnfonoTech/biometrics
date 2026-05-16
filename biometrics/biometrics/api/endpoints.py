# Copyright (c) 2026, Siva and contributors
# For license information, please see license.txt

"""
Whitelisted API endpoints for Biometrics integration.
These can be called from the frontend or external systems.
"""

import frappe

@frappe.whitelist()
def add_device_to_biometrics(serial_number, alias=None, ip_address=None, area_id=None):
	"""Register a new device in Biometrics via API
	Note: Biometrics typically auto-discovers devices. This is for manual registration.
	"""
	settings = frappe.get_single("Biometrics Settings")
	if settings.block_new_registrations:
		frappe.throw("New device registrations are blocked. Disable this in Biometrics Settings.")

	from biometrics.biometrics.api.client import BiometricsClient

	client = BiometricsClient()

	# First check if device exists in Biometrics
	devices = client.get_devices(sn=serial_number)
	if devices:
		frappe.throw(f"Device with SN {serial_number} already exists in Biometrics")

	frappe.msgprint(
		f"Device {serial_number} needs to be added directly in Biometrics "
		"(devices register themselves via push protocol). "
		"Use 'Sync Devices' to pull it into ERPNext after it appears in Biometrics."
	)


@frappe.whitelist()
def test_device(serial_number):
	"""Test a specific device connection via Biometrics"""
	from biometrics.biometrics.api.client import BiometricsClient

	client = BiometricsClient()

	# Find device by SN
	devices = client.get_devices(sn=serial_number)
	if not devices:
		return {"success": False, "message": f"Device {serial_number} not found in Biometrics"}

	device = devices[0]
	state = device.get("state", 0)
	status = "Online" if state == 1 else "Offline"

	# Update local record
	if frappe.db.exists("Biometrics Device", serial_number):
		frappe.db.set_value("Biometrics Device", serial_number, "status", status)
		frappe.db.commit()

	return {
		"success": True,
		"status": status,
		"device": {
			"sn": device.get("sn"),
			"alias": device.get("alias"),
			"ip": device.get("ip_address"),
			"fw": device.get("fw_ver"),
			"users": device.get("user_count"),
			"last_activity": device.get("last_activity"),
		},
	}


@frappe.whitelist()
def push_employee_to_biometrics(emp_code, first_name, last_name=None, department_id=None, area_ids=None):
	"""Create or update an employee in Biometrics.

	Looks up the Biometrics internal employee ID via the API (by emp_code)
	to decide whether to create or update.
	"""
	from biometrics.biometrics.api.client import BiometricsClient

	client = BiometricsClient()

	data = {
		"emp_code": emp_code,
		"first_name": first_name,
	}
	if last_name:
		data["last_name"] = last_name
	if department_id:
		data["department"] = int(department_id)
	if area_ids:
		if isinstance(area_ids, str):
			area_ids = frappe.parse_json(area_ids)
		data["area"] = area_ids

	# Check if the employee already exists in Biometrics by querying the API
	existing = client.get_employees(emp_code=emp_code)
	if existing:
		biometrics_id = existing[0].get("id")
		result = client.update_employee(biometrics_id, data)
		return {"success": True, "action": "updated", "result": result}
	else:
		result = client.create_employee(data)
		return {"success": True, "action": "created", "result": result}


@frappe.whitelist()
def delete_employee_from_biometrics(emp_code):
	"""Delete an employee from Biometrics by looking up their ID via the API."""
	from biometrics.biometrics.api.client import BiometricsClient

	client = BiometricsClient()
	existing = client.get_employees(emp_code=emp_code)
	if not existing:
		frappe.throw(f"Employee {emp_code} not found in Biometrics")

	biometrics_id = existing[0].get("id")
	client.delete_employee(biometrics_id)
	return {"success": True, "message": f"Employee {emp_code} deleted from Biometrics"}


@frappe.whitelist()
def auto_map_all_employees():
	"""
	Try to auto-map all unmapped Biometrics employees to ERPNext employees.
	Uses the configured matching field (Attendance Device ID or Employee ID).
	"""
	settings = frappe.get_single("Biometrics Settings")
	unmapped = frappe.get_all(
		"Biometrics Employee",
		filters={"mapped": 0},
		fields=["name", "emp_code", "card_no"],
	)

	mapped_count = 0
	for emp in unmapped:
		employee = None

		if settings.employee_id_field == "Attendance Device ID":
			employee = frappe.db.get_value(
				"Employee",
				{"attendance_device_id": emp.emp_code, "status": "Active"},
				"name",
			)
			if not employee and emp.card_no:
				employee = frappe.db.get_value(
					"Employee",
					{"attendance_device_id": emp.card_no, "status": "Active"},
					"name",
				)
		else:
			employee = frappe.db.get_value(
				"Employee", {"name": emp.emp_code, "status": "Active"}, "name"
			)

		if employee:
			# Ensure not already mapped
			existing = frappe.db.get_value(
				"Biometrics Employee",
				{"erpnext_employee": employee, "name": ["!=", emp.name]},
				"name",
			)
			if not existing:
				frappe.db.set_value("Biometrics Employee", emp.name, {
					"erpnext_employee": employee,
					"mapped": 1,
				})
				mapped_count += 1

	frappe.db.commit()
	return {
		"total_unmapped": len(unmapped),
		"newly_mapped": mapped_count,
		"still_unmapped": len(unmapped) - mapped_count,
	}


@frappe.whitelist()
def create_missing_checkins():
	"""Create Employee Checkin records for all transaction logs that are mapped but don't have checkins yet"""
	logs = frappe.get_all(
		"Biometrics Transaction Log",
		filters={
			"checkin_created": 0,
			"erpnext_employee": ["is", "set"],
		},
		fields=["name"],
		limit=500,
	)

	created = 0
	failed = 0

	for log_data in logs:
		try:
			log = frappe.get_doc("Biometrics Transaction Log", log_data.name)
			result = log.create_employee_checkin()
			if result and result.get("success"):
				created += 1
			else:
				failed += 1
		except Exception:
			failed += 1

	frappe.db.commit()
	return {"created": created, "failed": failed, "total": len(logs)}


@frappe.whitelist()
def push_department_to_biometrics(dept_code, dept_name, parent_dept_id=None):
	"""Create or update a department in Biometrics"""
	from biometrics.biometrics.api.client import BiometricsClient

	client = BiometricsClient()
	data = {"dept_code": dept_code, "dept_name": dept_name}
	if parent_dept_id:
		data["parent_dept"] = int(parent_dept_id)

	biometrics_id = frappe.db.get_value(
		"Biometrics Department", dept_name, "biometrics_department_id"
	)

	if biometrics_id:
		result = client.update_department(biometrics_id, data)
		return {"success": True, "action": "updated", "result": result}
	else:
		result = client.create_department(data)
		if result and result.get("id"):
			frappe.db.set_value(
				"Biometrics Department", dept_name, "biometrics_department_id", result["id"]
			)
			frappe.db.commit()
		return {"success": True, "action": "created", "result": result}


@frappe.whitelist()
def delete_department_from_biometrics(dept_name):
	"""Delete a department from Biometrics"""
	from biometrics.biometrics.api.client import BiometricsClient

	biometrics_id = frappe.db.get_value(
		"Biometrics Department", dept_name, "biometrics_department_id"
	)
	if not biometrics_id:
		frappe.throw(f"Biometrics Department ID not found for {dept_name}")

	client = BiometricsClient()
	client.delete_department(biometrics_id)
	return {"success": True, "message": f"Department {dept_name} deleted from Biometrics"}


@frappe.whitelist()
def push_area_to_biometrics(area_code, area_name, parent_area_id=None):
	"""Create or update an area in Biometrics"""
	from biometrics.biometrics.api.client import BiometricsClient

	client = BiometricsClient()
	data = {"area_code": area_code, "area_name": area_name}
	if parent_area_id:
		data["parent_area"] = int(parent_area_id)

	biometrics_id = frappe.db.get_value("Biometrics Area", area_name, "biometrics_area_id")

	if biometrics_id:
		result = client.update_area(biometrics_id, data)
		return {"success": True, "action": "updated", "result": result}
	else:
		result = client.create_area(data)
		if result and result.get("id"):
			frappe.db.set_value("Biometrics Area", area_name, "biometrics_area_id", result["id"])
			frappe.db.commit()
		return {"success": True, "action": "created", "result": result}


@frappe.whitelist()
def push_position_to_biometrics(position_code, position_name, parent_position_id=None):
	"""Create or update a position in Biometrics"""
	from biometrics.biometrics.api.client import BiometricsClient

	client = BiometricsClient()
	data = {"position_code": position_code, "position_name": position_name}
	if parent_position_id:
		data["parent_position"] = int(parent_position_id)

	biometrics_id = frappe.db.get_value(
		"Biometrics Position", position_name, "biometrics_position_id"
	)

	if biometrics_id:
		result = client.update_position(biometrics_id, data)
		return {"success": True, "action": "updated", "result": result}
	else:
		result = client.create_position(data)
		if result and result.get("id"):
			frappe.db.set_value(
				"Biometrics Position", position_name, "biometrics_position_id", result["id"]
			)
			frappe.db.commit()
		return {"success": True, "action": "created", "result": result}


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
