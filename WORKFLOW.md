# Biometrics App — Workflow Documentation

**Copyright (c) 2026, Siva and contributors**

A Frappe/ERPNext app that integrates Biometrics 8.5 attendance machines with ERPNext HRMS. It pulls punch records, maps them to ERPNext employees, and automatically creates Employee Checkin records.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Initial Setup](#2-initial-setup)
3. [Master Data Sync](#3-master-data-sync)
4. [Employee Sync & Mapping](#4-employee-sync--mapping)
5. [Transaction Sync & Checkin Creation](#5-transaction-sync--checkin-creation)
6. [Auto-Sync Scheduler](#6-auto-sync-scheduler)
7. [Manual Operations](#7-manual-operations)
8. [Sync Log Monitoring](#8-sync-log-monitoring)
9. [Data Flow Diagram](#9-data-flow-diagram)
10. [DocType Reference](#10-doctype-reference)
11. [API Reference](#11-api-reference)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Architecture Overview

```
Biometrics Machine (8.5)
        │
        │  REST API (JWT / Token auth)
        ▼
  BiometricsClient  ──────────────────────────────────────────────┐
  (api/client.py)                                                  │
        │                                                          │
        ├── sync.py  (pull / push logic)                          │
        │      │                                                   │
        │      ├── Biometrics Device                              │
        │      ├── Biometrics Employee  ──► ERPNext Employee      │
        │      ├── Biometrics Department                          │
        │      ├── Biometrics Area                                │
        │      ├── Biometrics Position                            │
        │      └── Biometrics Transaction Log ──► Employee Checkin│
        │                                                          │
        └── endpoints.py  (whitelisted API for frontend calls)    │
                                                                   │
  Biometrics Settings  ◄─────────────────────────────────────────┘
  (single doctype — central config)
```

---

## 2. Initial Setup

### Step 1 — Configure Biometrics Settings

Navigate to: **Biometrics > Configuration > Biometrics Settings**

| Field | Description |
|---|---|
| Biometrics Server URL | Full URL with port, e.g. `http://192.168.1.100:70/` |
| Username | Biometrics admin username (default: `admin`) |
| Password | Biometrics admin password |
| Auth Token Type | `JWT` (recommended) or `General` |
| Default User | ERPNext user to own auto-generated records |

### Step 2 — Test the Connection

Click **Connection > Test Connection**. A green "Connected ✓" status confirms the server is reachable and credentials are valid. The auth token is cached in `auth_token` for subsequent calls.

### Step 3 — Configure Sync Options

| Section | Key Settings |
|---|---|
| Sync Configuration | Enable Auto Sync, Sync Interval (minutes), Sync Days Back |
| Data to Sync | Toggle which entity types to pull (Devices, Employees, Departments, Areas, Positions) |
| Employee Checkin Settings | Auto-Create Employee Checkin, Default Log Type (IN/OUT), Employee ID Matching Field |
| Employee Management | Block New Registrations, Log Retention Days |

---

## 3. Master Data Sync

Master data (departments, areas, positions, devices) must be synced before employees, because employees reference these records.

### Sync Order (automatic in Full Sync)

```
1. Departments  (no dependencies)
2. Areas        (no dependencies)
3. Positions    (no dependencies)
4. Devices      (references Areas)
5. Employees    (references Departments, Positions, Areas)
6. Transactions (references Employees)
```

### How to Trigger

- **Full Sync**: Settings → Sync > Full Sync Now (syncs everything in the correct order)
- **Per-entity**: Settings → Sync > Sync Devices / Sync Departments / Sync Areas / Sync Positions

### What Gets Created/Updated

| Biometrics Entity | ERPNext DocType | Key Fields |
|---|---|---|
| Terminal | Biometrics Device | `serial_number`, `alias`, `ip_address`, `status`, `biometrics_device_id` |
| Department | Biometrics Department | `dept_code`, `dept_name`, `parent_department`, `biometrics_department_id` |
| Area | Biometrics Area | `area_code`, `area_name`, `parent_area`, `biometrics_area_id` |
| Position | Biometrics Position | `position_code`, `position_name`, `parent_position`, `biometrics_position_id` |

Parent relationships (department hierarchy, area hierarchy) are set in a second pass after all records are created, to avoid ordering issues.

---

## 4. Employee Sync & Mapping

### 4a. Pulling Employees from Biometrics

When employees are synced, each Biometrics employee is stored in **Biometrics Employee** with all profile fields (name, card number, department, position, area, contact info, etc.).

The `biometrics_employee_id` field stores the internal Biometrics integer ID used for push-back operations.

### 4b. Auto-Mapping to ERPNext Employees

Controlled by **Employee ID Matching Field** in Settings:

| Matching Field | Logic |
|---|---|
| `Attendance Device ID` | Matches `emp_code` (or `card_no`) against `Employee.attendance_device_id` |
| `Employee ID` | Matches `emp_code` against the ERPNext Employee name/ID |
| `Employee Name` | Matches by name |

When a match is found and no other Biometrics Employee is already mapped to that ERPNext Employee, the `erpnext_employee` field is set and `mapped = 1`.

**Auto-mapping runs:**
- During employee sync (if `Auto-Map Employees on Sync` is enabled)
- When you manually click **Auto Map to ERPNext** on a Biometrics Employee record
- Via the **Validate Transaction Logs** bulk action

### 4c. Mapping Triggers Backfill

When `erpnext_employee` is set on a Biometrics Employee (either manually or via auto-map), the `on_update` hook automatically:

1. Finds all **Biometrics Transaction Logs** for that `emp_code` where `erpnext_employee` is not set
2. Sets the `erpnext_employee` on each log
3. Creates **Employee Checkin** records for each log (if `Auto-Create Employee Checkin` is enabled)

This handles the common case where transactions were already synced before the employee was mapped.

### 4d. Pushing Employees to Biometrics

From a **Biometrics Employee** record → **Push to Biometrics** button. Creates or updates the employee in Biometrics via API. Useful when you create employees in ERPNext first and need them in the attendance device.

---

## 5. Transaction Sync & Checkin Creation

### 5a. Transaction Sync Flow

```
Biometrics Machine
       │
       │  GET /iclock/api/transactions/
       │  (filtered by start_time → end_time)
       ▼
Biometrics Transaction Log
       │
       │  before_save:
       │  1. _map_log_type()   → maps punch_state (0-5) to IN / OUT
       │  2. _resolve_employee() → looks up ERPNext Employee from emp_code
       ▼
Employee Checkin  (if erpnext_employee resolved and setting enabled)
```

### 5b. Punch State → Log Type Mapping

| punch_state | Meaning | Log Type |
|---|---|---|
| 0 | Check In | IN |
| 1 | Check Out | OUT |
| 2 | Break Out | OUT |
| 3 | Break In | IN |
| 4 | OT In | IN |
| 5 | OT Out | OUT |
| other | Unknown | Default from Settings |

### 5c. Duplicate Prevention

A transaction is skipped if:
- `biometrics_transaction_id` already exists in the database, **or**
- A record with the same `emp_code` + `punch_time` already exists

### 5d. Time Range

- **First sync**: pulls from `now - sync_days_back` (default 7 days)
- **Subsequent syncs**: pulls from `last_transaction_sync` timestamp onwards
- After each successful sync, `last_transaction_sync` is updated to now

### 5e. Creating Employee Checkins Manually

On a **Biometrics Transaction Log** record that has `erpnext_employee` set but `checkin_created = 0`, click **Create Employee Checkin**. The checkin is linked back via `employee_checkin` field.

---

## 6. Auto-Sync Scheduler

The scheduler runs `scheduled_sync()` every **5 minutes** (via cron in `hooks.py`).

Each run checks:
1. Is `enable_auto_sync = 1` in Biometrics Settings? If not, exit.
2. Has enough time elapsed since `last_transaction_sync`? (uses `sync_interval_minutes`, minimum 5)
3. If yes → calls `sync_transactions()` → pulls new punch records → creates checkins

This means you can set a 15-minute interval and the scheduler will respect it, even though it checks every 5 minutes.

---

## 7. Manual Operations

All manual triggers are available from **Biometrics Settings**:

| Button | Group | Action |
|---|---|---|
| Test Connection | Connection | Verifies credentials, caches auth token |
| Full Sync Now | Sync | Queues a long job: departments → areas → positions → devices → employees → transactions |
| Sync Transactions | Sync | Queues transaction-only sync |
| Sync Devices/Employees/Departments/Areas/Positions | Sync | Queue a single-entity sync |
| Validate Transaction Logs | Sync | Bulk-backfills `erpnext_employee` on all unmapped transaction logs and creates missing checkins |
| View Sync Logs | View | Navigates to Biometrics Sync Log list |
| View Devices / Employees / Transaction Logs | View | Quick navigation |

All syncs run as background jobs (Frappe queue) to avoid timeouts. Progress is visible in **Biometrics Sync Log**.

---

## 8. Sync Log Monitoring

Every sync operation creates a **Biometrics Sync Log** record.

| Field | Description |
|---|---|
| Sync Type | Full Sync / Transactions / Devices / Employees / Departments / Areas / Positions |
| Status | Queued → In Progress → Completed / Failed / Partially Failed |
| Started At / Completed At | Timestamps |
| Duration (seconds) | How long the sync took |
| Triggered By | Which user or scheduler triggered it |
| Total Records | Records fetched from Biometrics |
| Records Created / Updated / Failed | Breakdown of what happened |
| Employee Checkins Created | How many checkin records were made |
| Log Details | Per-entity summary text |
| Error Log | Full error message if the sync failed |

The **Biometrics** workspace dashboard shows:
- A **Donut chart** of sync statuses (Sync Activity)
- A **Bar chart** of daily checkins (Checkins This Month)
- Number cards for devices, mapped/unmapped employees, and today's transactions

---

## 9. Data Flow Diagram

```
┌──────────────────────────────────────────────────────────┐
│                   Biometrics Machine                     │
│  Employees │ Departments │ Areas │ Positions │ Terminals │
│                  Punch Transactions                      │
└───────────────────────┬──────────────────────────────────┘
                        │ REST API
                        ▼
               ┌─────────────────┐
               │ BiometricsClient│  (api/client.py)
               │  JWT/Token auth │
               └────────┬────────┘
                        │
            ┌───────────┴────────────┐
            │      api/sync.py       │
            │  Full Sync / Scheduled │
            └───────────┬────────────┘
                        │
        ┌───────────────┼───────────────────┐
        ▼               ▼                   ▼
  Biometrics      Biometrics          Biometrics
  Department /    Device              Employee
  Area / Position                     │
                                      │ auto-map
                                      ▼
                               ERPNext Employee
                                      │
                        ┌─────────────┘
                        ▼
               Biometrics Transaction Log
                        │
                        │ before_save:
                        │  - map punch_state → log_type
                        │  - resolve erpnext_employee
                        │
                        ▼
                Employee Checkin  ──► ERPNext HRMS
                (Attendance / Leave processing)
```

---

## 10. DocType Reference

### Biometrics Settings *(Single)*
Central configuration. One record per site.

### Biometrics Device
One record per physical attendance terminal. Auto-named by `serial_number`.
- Linked to **Biometrics Area**
- Linked from **Biometrics Transaction Log** (via `device_sn`)

### Biometrics Employee
One record per employee in the machine. Auto-named by `emp_code`.
- Links to **Biometrics Department**, **Biometrics Position**, **Biometrics Area**
- Links to **ERPNext Employee** (when mapped)
- One-to-one mapping enforced: no two Biometrics Employees can map to the same ERPNext Employee

### Biometrics Department
Hierarchical. Supports `parent_department`.

### Biometrics Area
Hierarchical. Supports `parent_area`.

### Biometrics Position
Hierarchical. Supports `parent_position`.

### Biometrics Sync Log *(read-only)*
Auto-created by every sync. Named by random hash. Never edit manually.

### Biometrics Transaction Log *(read-only)*
One record per punch event from the machine. Named by random hash.
- `biometrics_transaction_id` — unique ID from the machine
- `emp_code` — raw employee code from punch
- `punch_time` — exact punch datetime
- `punch_state` — raw state code (0–5)
- `log_type` — resolved IN/OUT
- `erpnext_employee` — resolved ERPNext Employee link
- `checkin_created` — whether Employee Checkin was made
- `employee_checkin` — link to the created checkin record

---

## 11. API Reference

### Python API (whitelisted, callable from frontend)

**`biometrics.biometrics.api.endpoints`**

| Function | Purpose |
|---|---|
| `auto_map_all_employees()` | Bulk auto-map all unmapped Biometrics Employees to ERPNext |
| `create_missing_checkins()` | Create checkins for all mapped-but-unchecked transaction logs |
| `push_employee_to_biometrics(emp_code, ...)` | Create/update employee in the machine |
| `delete_employee_from_biometrics(emp_code)` | Remove employee from the machine |
| `push_department_to_biometrics(dept_code, dept_name, ...)` | Push department |
| `push_area_to_biometrics(area_code, area_name, ...)` | Push area |
| `push_position_to_biometrics(position_code, position_name, ...)` | Push position |
| `test_device(serial_number)` | Ping a device and update its online/offline status |
| `get_biometrics_dashboard_data()` | Returns summary counts for dashboard widgets |

**`biometrics.biometrics.api.sync`**

| Function | Purpose |
|---|---|
| `full_sync()` | Sync all entities in dependency order |
| `sync_transactions()` | Sync only punch records |
| `sync_entity(entity)` | Sync one entity type (`devices`, `employees`, `departments`, `areas`, `positions`) |
| `scheduled_sync()` | Called by cron — runs transaction sync if interval elapsed |

### DocType Methods

| DocType | Method | Purpose |
|---|---|---|
| Biometrics Settings | `test_connection()` | Test server reachability |
| Biometrics Settings | `full_sync()` | Enqueue full sync job |
| Biometrics Settings | `sync_transactions()` | Enqueue transaction sync job |
| Biometrics Settings | `sync_entity(entity)` | Enqueue single-entity sync |
| Biometrics Device | `ping_device()` | Check device online/offline status |
| Biometrics Device | `sync_from_biometrics()` | Refresh this device's data |
| Biometrics Employee | `auto_map_to_erpnext()` | Auto-map this employee |
| Biometrics Employee | `push_to_biometrics()` | Push this employee to machine |
| Biometrics Transaction Log | `create_employee_checkin()` | Manually create checkin for this record |

---

## 12. Troubleshooting

### Connection fails
- Verify the server URL includes the port (e.g. `:70`)
- Check that the Biometrics service is running and reachable from the ERPNext server
- Try `JWT` vs `General` token type — depends on your Biometrics version
- Firewall may be blocking the port

### Employees not mapping
- Check **Employee ID Matching Field** — it must match how your ERPNext employees are identified
- Ensure the ERPNext Employee has `attendance_device_id` populated (if using that field)
- One employee can only map to one Biometrics Employee — check for duplicates

### Transaction logs have no ERPNext Employee
- The employee was likely synced after transactions. Run **Validate Transaction Logs** from Settings to backfill.
- If the employee is still unmapped, map them manually on the Biometrics Employee record first.

### Employee Checkins not being created
- Confirm `Auto-Create Employee Checkin` is enabled in Settings
- The transaction log must have `erpnext_employee` set
- Check the `error_message` field on the transaction log for the specific failure reason

### Duplicate checkins
- The system checks for existing checkins by `(employee, time)` before creating — duplicates are skipped
- If you see duplicates it means the same transaction was inserted with a different punch_time precision

### Sync is slow or timing out
- Full sync runs as a background job (Frappe `long` queue) — check the worker is running
- Run `bench worker --queue long` if the long queue worker is not active
- Large transaction volumes: the sync commits every 100 records to avoid memory issues

### Checking sync status
Navigate to **Biometrics > Configuration > Biometrics Sync Log** to see all past syncs, their status, duration, and any error messages.
