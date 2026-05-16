// Copyright (c) 2026, Siva and contributors
// For license information, please see license.txt

frappe.pages["biometrics-dashboard"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("Biometrics Dashboard"),
		single_column: true,
	});
	new BiometricsDashboard(page);
};

/* ─────────────────────────────────────────────────────────────────── */
class BiometricsDashboard {
	constructor(page) {
		this.page = page;
		this.today = frappe.datetime.get_today();
		this.filters = {
			date_from: this.today,
			date_to: this.today,
			employee: "",
			department: "",
		};
		this.charts = {};
		this._inject_styles();
		this._setup_page_actions();
		this._setup_filters();
		this._render_layout();
		this._load_all();
	}

	/* ── Page toolbar ──────────────────────────────────────────────── */
	_setup_page_actions() {
		this.page.set_secondary_action(__("Refresh"), () => this._load_all(), {
			icon: "es-line-reload",
		});

		this.page.add_menu_item(__("Sync Logs for Employee"), () =>
			this._show_employee_sync_dialog()
		);
		this.page.add_menu_item(__("Re-sync Date Range"), () =>
			this._show_resync_dialog()
		);
		this.page.add_menu_item(__("Repair Missing Checkins"), () =>
			this._repair_checkins()
		);
		this.page.add_menu_item(__("Open Biometrics Settings"), () =>
			frappe.set_route("Form", "Biometrics Settings")
		);
	}

	/* ── Filters ───────────────────────────────────────────────────── */
	_setup_filters() {
		this.f_from = this.page.add_field({
			fieldname: "date_from",
			label: __("From"),
			fieldtype: "Date",
			default: this.today,
			change: () => {
				this.filters.date_from = this.f_from.get_value() || this.today;
				this._load_all();
			},
		});

		this.f_to = this.page.add_field({
			fieldname: "date_to",
			label: __("To"),
			fieldtype: "Date",
			default: this.today,
			change: () => {
				this.filters.date_to = this.f_to.get_value() || this.today;
				this._load_all();
			},
		});

		this.f_emp = this.page.add_field({
			fieldname: "employee",
			label: __("Employee"),
			fieldtype: "Link",
			options: "Employee",
			change: () => {
				this.filters.employee = this.f_emp.get_value();
				this._load_all();
			},
		});

		this.f_dept = this.page.add_field({
			fieldname: "department",
			label: __("Department"),
			fieldtype: "Link",
			options: "Department",
			change: () => {
				this.filters.department = this.f_dept.get_value();
				this._load_all();
			},
		});
	}

	/* ── Layout skeleton ───────────────────────────────────────────── */
	_render_layout() {
		$(this.page.main).html(`
		<div class="bm-page">

			<!-- ── Stats Row ─────────────────────────────────── -->
			<div class="bm-stats-row" id="bm-stats">
				${this._stat_skeleton(6)}
			</div>

			<!-- ── Charts Row ────────────────────────────────── -->
			<div class="bm-charts-row">
				<div class="bm-card bm-chart-card" id="bm-trend-wrap">
					<div class="bm-card-header">
						<span class="bm-card-title">${__("Punch Trend")}</span>
						<span class="bm-card-sub" id="bm-trend-sub">${__("Last 7 days")}</span>
					</div>
					<div id="bm-trend-chart" class="bm-chart-area"></div>
				</div>
				<div class="bm-side-charts">
					<div class="bm-card bm-chart-card" id="bm-hour-wrap">
						<div class="bm-card-header">
							<span class="bm-card-title">${__("Punches by Hour")}</span>
						</div>
						<div id="bm-hour-chart" class="bm-chart-area bm-chart-sm"></div>
					</div>
					<div class="bm-card bm-device-summary" id="bm-dev-summary">
						<div class="bm-card-header">
							<span class="bm-card-title">${__("Device Health")}</span>
						</div>
						<div id="bm-device-health"></div>
					</div>
				</div>
			</div>

			<!-- ── Attendance Table ──────────────────────────── -->
			<div class="bm-card bm-table-card" id="bm-attend-card">
				<div class="bm-card-header">
					<span class="bm-card-title">${__("Employee Attendance")}</span>
					<input class="bm-search" id="bm-attend-search"
						placeholder="${__("Search employee…")}" type="search">
				</div>
				<div class="bm-table-wrap" id="bm-attend-table">
					${this._table_skeleton()}
				</div>
			</div>

			<!-- ── Transaction Log Table ─────────────────────── -->
			<div class="bm-card bm-table-card" id="bm-txn-card">
				<div class="bm-card-header">
					<span class="bm-card-title">${__("Recent Punch Activity")}</span>
					<div class="bm-header-actions">
						<input class="bm-search" id="bm-txn-search"
							placeholder="${__("Search…")}" type="search">
					</div>
				</div>
				<div class="bm-table-wrap" id="bm-txn-table">
					${this._table_skeleton()}
				</div>
			</div>

			<!-- ── Devices Table ─────────────────────────────── -->
			<div class="bm-card bm-table-card" id="bm-dev-card">
				<div class="bm-card-header">
					<span class="bm-card-title">${__("Biometrics Devices")}</span>
				</div>
				<div class="bm-table-wrap" id="bm-dev-table">
					${this._table_skeleton()}
				</div>
			</div>

		</div>`);

		// Wire up live search
		this._wire_search("#bm-attend-search", "#bm-attend-table", "tr.bm-row");
		this._wire_search("#bm-txn-search",    "#bm-txn-table",    "tr.bm-row");
	}

	/* ── Data loaders ──────────────────────────────────────────────── */
	_load_all() {
		this._load_summary();
		this._load_trend();
		this._load_hourly();
		this._load_attendance();
		this._load_transactions();
		this._load_devices();
	}

	_call(method, args, cb) {
		frappe.call({
			method: `biometrics.biometrics.page.biometrics_dashboard.biometrics_dashboard.${method}`,
			args: { ...this.filters, ...args },
			callback: (r) => r.message && cb(r.message),
		});
	}

	_load_summary() {
		this._call("get_summary", {}, (d) => this._render_stats(d));
	}

	_load_trend() {
		this._call("get_punch_trend", { days: 7 }, (d) => this._render_trend(d));
	}

	_load_hourly() {
		this._call("get_hourly_heatmap", {}, (d) => this._render_hourly(d));
	}

	_load_attendance() {
		this._call("get_today_attendance", {}, (d) => this._render_attendance(d));
	}

	_load_transactions() {
		this._call("get_recent_transactions", { limit: 100 }, (d) =>
			this._render_transactions(d)
		);
	}

	_load_devices() {
		this._call("get_device_status", {}, (d) => {
			this._render_devices(d);
			this._render_device_health(d);
		});
	}

	/* ── Renderers ─────────────────────────────────────────────────── */
	_render_stats(d) {
		const fmt = (n) => frappe.utils.formatNumber(n || 0);
		const pct = d.enrolled
			? Math.round((d.enrolled / d.total_active) * 100)
			: 0;
		const chkPct = d.punches_period
			? Math.round((d.checkins_period / d.punches_period) * 100)
			: 0;
		const lastSync = d.last_transaction_sync
			? frappe.datetime.comment_when(d.last_transaction_sync)
			: __("Never");

		const stats = [
			{
				icon: "👥",
				value: fmt(d.enrolled),
				label: __("Enrolled Employees"),
				sub: `${pct}% of ${fmt(d.total_active)} active`,
				color: "blue",
				link: () => frappe.set_route("List", "Employee", { attendance_device_id: ["is", "set"] }),
			},
			{
				icon: "⚠️",
				value: fmt(d.not_enrolled),
				label: __("Missing Device ID"),
				sub: __("Not linked to machine"),
				color: d.not_enrolled ? "orange" : "green",
				link: () =>
					frappe.call({
						method: "biometrics.biometrics.api.endpoints.get_employees_missing_device_id",
						callback: (r) => this._show_missing_emp_dialog(r.message),
					}),
			},
			{
				icon: "📡",
				value: `${fmt(d.devices_online)} / ${fmt(d.devices_total)}`,
				label: __("Devices Online"),
				sub: `${fmt(d.devices_offline)} offline`,
				color: d.devices_offline ? "orange" : "green",
				link: () => frappe.set_route("List", "Biometrics Device"),
			},
			{
				icon: "👆",
				value: fmt(d.punches_period),
				label: __("Punches (Period)"),
				sub: `${fmt(d.unmatched_period)} unmatched`,
				color: "teal",
				link: () => frappe.set_route("List", "Biometrics Transaction Log"),
			},
			{
				icon: "✅",
				value: fmt(d.checkins_period),
				label: __("Checkins Created"),
				sub: `${chkPct}% of punches`,
				color: chkPct < 90 ? "orange" : "green",
				link: () => frappe.set_route("List", "Employee Checkin"),
			},
			{
				icon: d.auto_sync ? "🔄" : "⏸️",
				value: d.auto_sync ? __("Active") : __("Off"),
				label: __("Auto Sync"),
				sub: `${__("Last")}: ${lastSync}`,
				color: d.auto_sync ? "green" : "gray",
				link: () => frappe.set_route("Form", "Biometrics Settings"),
			},
		];

		$("#bm-stats").html(
			stats
				.map(
					(s) => `
			<div class="bm-stat-card bm-stat-${s.color}" title="${__("Click to view details")}">
				<div class="bm-stat-icon">${s.icon}</div>
				<div class="bm-stat-value">${s.value}</div>
				<div class="bm-stat-label">${s.label}</div>
				<div class="bm-stat-sub">${s.sub}</div>
			</div>`
				)
				.join("")
		);

		// Attach click handlers
		$("#bm-stats .bm-stat-card").each(function (i) {
			$(this).on("click", () => stats[i].link && stats[i].link());
		});
	}

	_render_trend(rows) {
		if (!rows.length) {
			$("#bm-trend-chart").html(this._empty_state(__("No punch data for the last 7 days")));
			return;
		}

		const labels = rows.map((r) => frappe.datetime.str_to_user(r.punch_date));
		const punchData = rows.map((r) => r.punch_count);
		const checkinData = rows.map((r) => r.checkin_count || 0);

		if (this.charts.trend) {
			this.charts.trend.update({ labels, datasets: [{ values: punchData }, { values: checkinData }] });
			return;
		}

		this.charts.trend = new frappe.Chart("#bm-trend-chart", {
			type: "bar",
			data: {
				labels,
				datasets: [
					{ name: __("Punches"), values: punchData, chartType: "bar" },
					{ name: __("Checkins"), values: checkinData, chartType: "line" },
				],
			},
			colors: ["#2490EF", "#28a745"],
			height: 200,
			animate: true,
			barOptions: { spaceRatio: 0.3 },
			tooltipOptions: { formatTooltipX: (d) => d, formatTooltipY: (d) => d + " records" },
		});
	}

	_render_hourly(rows) {
		// Fill all 24 hours
		const byHour = {};
		rows.forEach((r) => (byHour[r.hour_of_day] = r.punch_count));

		const labels = [];
		const vals = [];
		for (let h = 0; h < 24; h++) {
			labels.push(h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`);
			vals.push(byHour[h] || 0);
		}

		if (this.charts.hourly) {
			this.charts.hourly.update({ labels, datasets: [{ values: vals }] });
			return;
		}

		if (!vals.some((v) => v > 0)) {
			$("#bm-hour-chart").html(this._empty_state(__("No data")));
			return;
		}

		this.charts.hourly = new frappe.Chart("#bm-hour-chart", {
			type: "bar",
			data: { labels, datasets: [{ name: __("Punches"), values: vals }] },
			colors: ["#7575ff"],
			height: 130,
			animate: true,
			barOptions: { spaceRatio: 0.15 },
			axisOptions: { xIsSeries: true },
		});
	}

	_render_device_health(devices) {
		const online = devices.filter((d) => d.status === "Online").length;
		const offline = devices.filter((d) => d.status === "Offline").length;
		const unknown = devices.length - online - offline;

		const bar = (label, count, total, cls) =>
			total
				? `<div class="bm-health-row">
					<span class="bm-health-label">${label}</span>
					<div class="bm-health-bar-wrap">
						<div class="bm-health-bar ${cls}" style="width:${Math.round((count / total) * 100)}%"></div>
					</div>
					<span class="bm-health-count">${count}</span>
				 </div>`
				: "";

		const total = devices.length || 1;
		$("#bm-device-health").html(
			devices.length
				? bar(__("Online"), online, total, "bm-bar-green") +
					bar(__("Offline"), offline, total, "bm-bar-red") +
					bar(__("Unknown"), unknown, total, "bm-bar-gray") +
					`<div class="bm-health-footer">${__("{0} total devices", [devices.length])}</div>`
				: this._empty_state(__("No devices found"))
		);
	}

	_render_attendance(rows) {
		if (!rows.length) {
			$("#bm-attend-table").html(
				this._empty_state(__("No attendance data for the selected period"))
			);
			return;
		}

		const fmt_time = (dt) =>
			dt ? frappe.datetime.str_to_user(dt).split(" ").pop() : "—";
		const status_badge = (row) => {
			const has_in = row.last_in;
			const has_out = row.last_out;
			if (has_in && has_out) return `<span class="bm-badge bm-badge-green">${__("Complete")}</span>`;
			if (has_in) return `<span class="bm-badge bm-badge-blue">${__("IN only")}</span>`;
			return `<span class="bm-badge bm-badge-orange">${__("No IN")}</span>`;
		};

		const rows_html = rows
			.map(
				(r) => `
			<tr class="bm-row" data-employee="${r.employee || ""}">
				<td>
					<div class="bm-emp-cell">
						<div class="bm-emp-avatar">${(r.employee_name || "?")[0].toUpperCase()}</div>
						<div>
							<div class="bm-emp-name">
								<a href="/app/employee/${r.employee}">${r.employee_name || r.employee}</a>
							</div>
							<div class="bm-emp-id">${r.employee || ""}</div>
						</div>
					</div>
				</td>
				<td>${r.department || "—"}</td>
				<td class="bm-time-cell bm-in">${fmt_time(r.first_punch)}</td>
				<td class="bm-time-cell bm-out">${fmt_time(r.last_punch)}</td>
				<td><span class="bm-punch-count">${r.total_punches}</span></td>
				<td>${status_badge(r)}</td>
				<td>
					<button class="bm-action-btn" data-emp="${r.employee}"
						title="${__("Sync logs for this employee")}">⟳</button>
				</td>
			</tr>`
			)
			.join("");

		$("#bm-attend-table").html(`
			<table class="bm-table">
				<thead>
					<tr>
						<th>${__("Employee")}</th>
						<th>${__("Department")}</th>
						<th>${__("First Punch")}</th>
						<th>${__("Last Punch")}</th>
						<th>${__("Punches")}</th>
						<th>${__("Status")}</th>
						<th></th>
					</tr>
				</thead>
				<tbody>${rows_html}</tbody>
			</table>
			<div class="bm-table-footer">${__("{0} employees present", [rows.length])}</div>
		`);

		// Per-row sync button
		const me = this;
		$("#bm-attend-table .bm-action-btn").on("click", function () {
			me._show_employee_sync_dialog($(this).data("emp"));
		});
	}

	_render_transactions(rows) {
		if (!rows.length) {
			$("#bm-txn-table").html(
				this._empty_state(__("No punch records for the selected period"))
			);
			return;
		}

		const verify_icon = (v) => {
			const map = { 1: "👆", 4: "💳", 15: "😀" };
			return map[v] || "❓";
		};

		const rows_html = rows
			.map(
				(r) => `
			<tr class="bm-row ${!r.erpnext_employee ? "bm-row-warn" : ""}">
				<td class="bm-time-col">
					<div class="bm-punch-time">${frappe.datetime.str_to_user(r.punch_time).split(" ").pop()}</div>
					<div class="bm-punch-date">${frappe.datetime.str_to_user(r.punch_time).split(" ")[0]}</div>
				</td>
				<td>
					${
						r.erpnext_employee
							? `<a href="/app/employee/${r.erpnext_employee}" class="bm-link">${r.employee_name || r.emp_code}</a>`
							: `<span class="bm-unmatched" title="${__("Not linked to ERPNext employee")}">${r.emp_code}</span>`
					}
					${r.department ? `<div class="bm-row-sub">${r.department}</div>` : ""}
				</td>
				<td>${r.device_alias || r.emp_code || "—"}</td>
				<td>${r.area_alias || "—"}</td>
				<td>
					${
						r.log_type === "IN"
							? `<span class="bm-badge bm-badge-green">IN</span>`
							: r.log_type === "OUT"
							? `<span class="bm-badge bm-badge-red">OUT</span>`
							: `<span class="bm-badge bm-badge-gray">—</span>`
					}
				</td>
				<td class="bm-center">
					${verify_icon(r.verify_type)}
				</td>
				<td class="bm-center">
					${
						r.checkin_created
							? `<a href="/app/employee-checkin/${r.employee_checkin}" class="bm-badge bm-badge-green" title="${r.employee_checkin}">✓</a>`
							: r.error_message
							? `<span class="bm-badge bm-badge-red" title="${r.error_message}">✗</span>`
							: `<span class="bm-badge bm-badge-gray">—</span>`
					}
				</td>
				<td>
					<a href="/app/biometrics-transaction-log/${r.name}" class="bm-icon-btn" title="${__("View log")}">↗</a>
				</td>
			</tr>`
			)
			.join("");

		$("#bm-txn-table").html(`
			<table class="bm-table">
				<thead>
					<tr>
						<th>${__("Time")}</th>
						<th>${__("Employee")}</th>
						<th>${__("Device")}</th>
						<th>${__("Area")}</th>
						<th>${__("Type")}</th>
						<th title="${__("Verify method: 👆 Fingerprint · 💳 Card · 😀 Face")}">${__("Mode")}</th>
						<th>${__("Checkin")}</th>
						<th></th>
					</tr>
				</thead>
				<tbody>${rows_html}</tbody>
			</table>
			<div class="bm-table-footer">${__("Showing {0} records", [rows.length])}</div>
		`);
	}

	_render_devices(devices) {
		if (!devices.length) {
			$("#bm-dev-table").html(this._empty_state(__("No devices configured")));
			return;
		}

		const since = (dt) =>
			dt ? frappe.datetime.comment_when(dt) : __("Never");

		const rows_html = devices
			.map(
				(d) => `
			<tr class="bm-row">
				<td>
					<div class="bm-dev-name">
						<span class="bm-dev-dot ${d.status === "Online" ? "bm-dot-green" : d.status === "Offline" ? "bm-dot-red" : "bm-dot-gray"}"></span>
						<a href="/app/biometrics-device/${d.name}" class="bm-link">${d.alias || d.serial_number}</a>
					</div>
					<div class="bm-row-sub">${d.serial_number}</div>
				</td>
				<td>${d.ip_address || "—"}</td>
				<td>${d.area_name || "—"}</td>
				<td>
					<span class="bm-badge ${
						d.status === "Online"
							? "bm-badge-green"
							: d.status === "Offline"
							? "bm-badge-red"
							: "bm-badge-gray"
					}">${d.status || "Unknown"}</span>
				</td>
				<td>${since(d.last_activity)}</td>
				<td class="bm-center">${d.user_count || 0}</td>
				<td class="bm-center">${d.transaction_count || 0}</td>
				<td class="bm-row-sub">${d.firmware_version || "—"}</td>
			</tr>`
			)
			.join("");

		$("#bm-dev-table").html(`
			<table class="bm-table">
				<thead>
					<tr>
						<th>${__("Device")}</th>
						<th>${__("IP Address")}</th>
						<th>${__("Area")}</th>
						<th>${__("Status")}</th>
						<th>${__("Last Seen")}</th>
						<th>${__("Users")}</th>
						<th>${__("Transactions")}</th>
						<th>${__("Firmware")}</th>
					</tr>
				</thead>
				<tbody>${rows_html}</tbody>
			</table>
			<div class="bm-table-footer">${__("{0} devices total", [devices.length])}</div>
		`);
	}

	/* ── Dialogs ────────────────────────────────────────────────────── */
	_show_employee_sync_dialog(employee = "") {
		const today = frappe.datetime.get_today();
		const week_ago = frappe.datetime.add_days(today, -7);
		const d = new frappe.ui.Dialog({
			title: __("Sync Attendance Logs for Employee"),
			fields: [
				{
					label: __("Employee"),
					fieldname: "employee",
					fieldtype: "Link",
					options: "Employee",
					default: employee,
					filters: { status: "Active" },
					reqd: 1,
				},
				{ fieldtype: "Column Break" },
				{ label: __("From Date"), fieldname: "date_from", fieldtype: "Date", default: week_ago, reqd: 1 },
				{ label: __("To Date"), fieldname: "date_to", fieldtype: "Date", default: today, reqd: 1 },
				{
					fieldtype: "HTML",
					options: `<p class="text-muted" style="font-size:12px;margin-top:8px">
						Fetches punch records directly from the machine for this employee.
						Duplicates are automatically skipped.
					</p>`,
				},
			],
			primary_action_label: __("Sync Now"),
			primary_action: (vals) => {
				d.hide();
				frappe.call({
					method: "biometrics.biometrics.api.endpoints.sync_employee_logs",
					args: vals,
					freeze: true,
					freeze_message: __("Fetching logs…"),
					callback: (r) => {
						if (!r.message) return;
						const m = r.message;
						frappe.msgprint({
							title: __("Sync Complete — {0}", [m.employee_name]),
							message: `
								<table style="width:100%;font-size:13px">
									<tr><td>${__("Device ID")}</td><td><b>${m.emp_code}</b></td></tr>
									<tr><td>${__("Period")}</td><td><b>${m.date_from} → ${m.date_to}</b></td></tr>
									<tr><td>${__("Fetched from machine")}</td><td><b>${m.total_fetched}</b></td></tr>
									<tr><td>${__("New logs created")}</td><td><b>${m.created}</b></td></tr>
									<tr><td>${__("Skipped (existing)")}</td><td><b>${m.skipped}</b></td></tr>
									<tr><td>${__("Checkins created")}</td><td><b>${m.checkins_created}</b></td></tr>
								</table>
								${m.errors && m.errors.length ? `<hr><b>${__("Errors")}:</b><br>${m.errors.join("<br>")}` : ""}
							`,
							indicator: m.created > 0 ? "green" : "blue",
						});
						this._load_all();
					},
				});
			},
		});
		d.show();
	}

	_show_resync_dialog() {
		const today = frappe.datetime.get_today();
		const d = new frappe.ui.Dialog({
			title: __("Re-sync All Employees — Date Range"),
			fields: [
				{ label: __("From Date"), fieldname: "date_from", fieldtype: "Date", default: frappe.datetime.add_days(today, -7), reqd: 1 },
				{ label: __("To Date"), fieldname: "date_to", fieldtype: "Date", default: today, reqd: 1 },
				{
					fieldtype: "HTML",
					options: `<p class="text-muted" style="font-size:12px;margin-top:8px">
						Re-pulls transactions for <b>all enrolled employees</b> in the chosen period.
						Duplicates are skipped. Runs as a background job — check <b>Biometrics Sync Log</b> for progress.
					</p>`,
				},
			],
			primary_action_label: __("Queue Re-sync"),
			primary_action: (vals) => {
				d.hide();
				frappe.call({
					method: "biometrics.biometrics.api.endpoints.resync_date_range",
					args: vals,
					freeze: true,
					freeze_message: __("Queuing re-sync…"),
					callback: (r) => {
						if (r.message) frappe.msgprint({ message: r.message.message, indicator: "blue" });
					},
				});
			},
		});
		d.show();
	}

	_repair_checkins() {
		frappe.confirm(
			__("Create Employee Checkin records for all transaction logs that have an ERPNext employee but no checkin yet (up to 2,000). Continue?"),
			() => {
				frappe.call({
					method: "biometrics.biometrics.api.endpoints.repair_employee_checkins",
					freeze: true,
					freeze_message: __("Repairing checkins…"),
					callback: (r) => {
						if (!r.message) return;
						const m = r.message;
						frappe.msgprint({
							title: __("Repair Complete"),
							message: __("Created: {0} &nbsp;|&nbsp; Already existed: {1} &nbsp;|&nbsp; Failed: {2}", [m.created, m.skipped, m.failed]),
							indicator: m.created > 0 ? "green" : "blue",
						});
						this._load_all();
					},
				});
			}
		);
	}

	_show_missing_emp_dialog(list) {
		if (!list || !list.length) {
			frappe.msgprint({ message: __("All active employees have an Attendance Device ID."), indicator: "green" });
			return;
		}
		const rows = list.map((e) =>
			`<tr><td>${e.name}</td><td>${e.employee_name}</td><td>${e.department || "—"}</td><td>${e.designation || "—"}</td>
				<td><a href="/app/employee/${e.name}" target="_blank">Edit ↗</a></td></tr>`
		).join("");
		frappe.msgprint({
			title: __("{0} Employee(s) Missing Attendance Device ID", [list.length]),
			message: `<div style="max-height:300px;overflow:auto">
				<table class="table table-bordered table-condensed" style="font-size:12px">
					<thead><tr><th>ID</th><th>Name</th><th>Department</th><th>Designation</th><th></th></tr></thead>
					<tbody>${rows}</tbody>
				</table></div>`,
			indicator: "orange",
		});
	}

	/* ── Helpers ────────────────────────────────────────────────────── */
	_wire_search(input_sel, table_sel, row_sel) {
		$(this.page.main).on("input", input_sel, function () {
			const q = $(this).val().toLowerCase();
			$(table_sel)
				.find(row_sel)
				.each(function () {
					$(this).toggle(!q || $(this).text().toLowerCase().includes(q));
				});
		});
	}

	_stat_skeleton(n) {
		return Array(n)
			.fill(`<div class="bm-stat-card bm-skeleton"></div>`)
			.join("");
	}

	_table_skeleton() {
		return `<div class="bm-skeleton-table">
			${Array(5).fill('<div class="bm-skeleton-row"></div>').join("")}
		</div>`;
	}

	_empty_state(msg) {
		return `<div class="bm-empty">${msg}</div>`;
	}

	/* ── Styles ─────────────────────────────────────────────────────── */
	_inject_styles() {
		if ($("#bm-styles").length) return;
		$("head").append(`<style id="bm-styles">
/* ── Page container ──────────────────────────────────── */
.bm-page { padding: 16px 20px 40px; font-family: var(--font-stack); }

/* ── Stat cards ──────────────────────────────────────── */
.bm-stats-row {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
	gap: 14px;
	margin-bottom: 20px;
}
.bm-stat-card {
	background: #fff;
	border-radius: 12px;
	padding: 18px 16px 14px;
	box-shadow: 0 1px 4px rgba(0,0,0,.08);
	cursor: pointer;
	transition: transform .15s, box-shadow .15s;
	border-top: 4px solid transparent;
	position: relative;
}
.bm-stat-card:hover { transform: translateY(-2px); box-shadow: 0 4px 14px rgba(0,0,0,.12); }
.bm-stat-icon { font-size: 22px; margin-bottom: 6px; }
.bm-stat-value { font-size: 26px; font-weight: 700; line-height: 1.1; color: var(--text-color); }
.bm-stat-label { font-size: 12px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: .4px; margin-top: 4px; }
.bm-stat-sub { font-size: 11px; color: var(--text-muted); margin-top: 2px; }

.bm-stat-blue   { border-color: #2490EF; }
.bm-stat-green  { border-color: #28a745; }
.bm-stat-orange { border-color: #f4842b; }
.bm-stat-teal   { border-color: #17a2b8; }
.bm-stat-red    { border-color: #e74c3c; }
.bm-stat-gray   { border-color: #adb5bd; }

/* ── Charts row ──────────────────────────────────────── */
.bm-charts-row {
	display: grid;
	grid-template-columns: 1fr 340px;
	gap: 14px;
	margin-bottom: 20px;
}
.bm-side-charts { display: flex; flex-direction: column; gap: 14px; }
.bm-card {
	background: #fff;
	border-radius: 12px;
	box-shadow: 0 1px 4px rgba(0,0,0,.08);
	overflow: hidden;
}
.bm-chart-card { padding: 16px; }
.bm-device-summary { padding: 16px; }
.bm-card-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	margin-bottom: 12px;
}
.bm-card-title { font-weight: 700; font-size: 14px; color: var(--text-color); }
.bm-card-sub   { font-size: 11px; color: var(--text-muted); }
.bm-chart-area { min-height: 200px; }
.bm-chart-sm   { min-height: 130px; }

/* ── Device health bars ───────────────────────────────── */
.bm-health-row { display: flex; align-items: center; margin-bottom: 10px; gap: 8px; }
.bm-health-label { font-size: 12px; width: 60px; color: var(--text-muted); }
.bm-health-bar-wrap { flex: 1; background: var(--border-color); border-radius: 4px; height: 8px; }
.bm-health-bar { height: 8px; border-radius: 4px; transition: width .4s; }
.bm-bar-green { background: #28a745; }
.bm-bar-red   { background: #e74c3c; }
.bm-bar-gray  { background: #adb5bd; }
.bm-health-count { font-size: 12px; font-weight: 700; width: 24px; text-align: right; }
.bm-health-footer { font-size: 11px; color: var(--text-muted); margin-top: 6px; }

/* ── Table cards ─────────────────────────────────────── */
.bm-table-card { margin-bottom: 20px; }
.bm-table-card .bm-card-header {
	padding: 14px 16px 0;
	flex-wrap: wrap;
	gap: 8px;
}
.bm-header-actions { display: flex; gap: 8px; align-items: center; }
.bm-table-wrap { overflow-x: auto; }

.bm-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.bm-table thead tr { background: var(--subtle-fg); }
.bm-table th {
	padding: 10px 12px;
	font-size: 11px;
	font-weight: 700;
	text-transform: uppercase;
	letter-spacing: .4px;
	color: var(--text-muted);
	text-align: left;
	white-space: nowrap;
	border-bottom: 1px solid var(--border-color);
}
.bm-table td {
	padding: 10px 12px;
	border-bottom: 1px solid var(--border-color);
	vertical-align: middle;
}
.bm-row:hover td { background: #f8fbff; }
.bm-row-warn td  { background: #fff9f0; }

.bm-table-footer {
	padding: 8px 12px;
	font-size: 11px;
	color: var(--text-muted);
	text-align: right;
	border-top: 1px solid var(--border-color);
}

/* ── Table cells ─────────────────────────────────────── */
.bm-emp-cell { display: flex; align-items: center; gap: 10px; }
.bm-emp-avatar {
	width: 30px; height: 30px; border-radius: 50%;
	background: linear-gradient(135deg, #2490EF, #7575ff);
	color: #fff; font-weight: 700; font-size: 13px;
	display: flex; align-items: center; justify-content: center;
	flex-shrink: 0;
}
.bm-emp-name a { font-weight: 600; color: var(--text-color); text-decoration: none; }
.bm-emp-name a:hover { color: #2490EF; }
.bm-emp-id   { font-size: 11px; color: var(--text-muted); }
.bm-row-sub  { font-size: 11px; color: var(--text-muted); }

.bm-time-cell { font-weight: 600; font-family: var(--font-monospace, monospace); }
.bm-in  { color: #28a745; }
.bm-out { color: #e74c3c; }
.bm-punch-count {
	background: var(--subtle-fg);
	border-radius: 20px;
	padding: 2px 10px;
	font-weight: 700;
	font-size: 12px;
}
.bm-time-col .bm-punch-time { font-weight: 700; font-family: var(--font-monospace, monospace); }
.bm-time-col .bm-punch-date { font-size: 11px; color: var(--text-muted); }
.bm-unmatched { color: #f4842b; font-style: italic; }
.bm-center { text-align: center; }
.bm-link { color: #2490EF; text-decoration: none; }
.bm-link:hover { text-decoration: underline; }
.bm-icon-btn {
	color: var(--text-muted); font-size: 14px;
	text-decoration: none; padding: 2px 4px;
}
.bm-icon-btn:hover { color: #2490EF; }

/* ── Device cells ─────────────────────────────────────── */
.bm-dev-name { display: flex; align-items: center; gap: 8px; }
.bm-dev-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.bm-dot-green { background: #28a745; box-shadow: 0 0 4px #28a74580; }
.bm-dot-red   { background: #e74c3c; }
.bm-dot-gray  { background: #adb5bd; }

/* ── Badges ──────────────────────────────────────────── */
.bm-badge {
	display: inline-block;
	padding: 2px 8px;
	border-radius: 20px;
	font-size: 11px;
	font-weight: 700;
	text-decoration: none;
}
.bm-badge-green  { background: #d4edda; color: #155724; }
.bm-badge-blue   { background: #cce5ff; color: #004085; }
.bm-badge-orange { background: #fff3cd; color: #856404; }
.bm-badge-red    { background: #f8d7da; color: #721c24; }
.bm-badge-gray   { background: var(--subtle-fg); color: var(--text-muted); }

/* ── Search input ─────────────────────────────────────── */
.bm-search {
	border: 1px solid var(--border-color);
	border-radius: 6px;
	padding: 5px 10px;
	font-size: 12px;
	outline: none;
	width: 200px;
	transition: border-color .15s;
}
.bm-search:focus { border-color: #2490EF; }

/* ── Action button ───────────────────────────────────── */
.bm-action-btn {
	background: none;
	border: 1px solid var(--border-color);
	border-radius: 6px;
	padding: 2px 8px;
	cursor: pointer;
	font-size: 14px;
	color: var(--text-muted);
	transition: all .15s;
}
.bm-action-btn:hover { background: #2490EF; color: #fff; border-color: #2490EF; }

/* ── Empty & skeleton states ─────────────────────────── */
.bm-empty {
	padding: 40px;
	text-align: center;
	color: var(--text-muted);
	font-size: 13px;
}
.bm-skeleton { animation: bm-pulse 1.2s ease-in-out infinite; }
.bm-skeleton-table { padding: 12px; }
.bm-skeleton-row {
	height: 36px; background: var(--subtle-fg);
	border-radius: 6px; margin-bottom: 8px;
	animation: bm-pulse 1.2s ease-in-out infinite;
}
@keyframes bm-pulse {
	0%, 100% { opacity: 1; }
	50%       { opacity: .4; }
}

/* ── Dark mode adjustments ──────────────────────────── */
[data-theme="dark"] .bm-stat-card,
[data-theme="dark"] .bm-card  { background: var(--card-bg); }
[data-theme="dark"] .bm-row:hover td { background: rgba(36,144,239,.06); }
</style>`);
	}
}
