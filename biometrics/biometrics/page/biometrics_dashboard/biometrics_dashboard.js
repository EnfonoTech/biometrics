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

/* ─────────────────────────────────────────────────────────────────────────── */
class BiometricsDashboard {
	constructor(page) {
		this.page    = page;
		this.today   = frappe.datetime.get_today();
		this.filters = { date_from: this.today, date_to: this.today, employee: "", department: "" };
		this.charts  = {};
		this._auto_refresh_timer = null;
		this._auto_refresh_remaining = 0;
		this._inout_rows = [];          // cache for CSV export
		this._monthly_rows = [];
		this._inject_styles();
		this._setup_page_actions();
		this._setup_filters();
		this._render_layout();
		this._load_all();
	}

	/* ── Page toolbar ───────────────────────────────────────────────── */
	_setup_page_actions() {
		// Primary: Sync Now (feature 4)
		this.page.set_primary_action(__("Sync Now"), () => this._trigger_sync(), { icon: "es-line-reload" });

		// Secondary: Refresh display
		this.page.set_secondary_action(__("Refresh"), () => this._load_all(), { icon: "es-line-reload" });

		this.page.add_menu_item(__("Auto-Refresh: OFF"), () => this._toggle_auto_refresh(), false, "auto-refresh-menu");
		this.page.add_menu_item(__("Monthly Summary"), () => this._show_monthly_dialog());
		this.page.add_menu_item(__("Export IN/OUT to CSV"), () => this._export_csv());
		this.page.add_menu_item(__("Sync Logs for Employee"), () => this._show_employee_sync_dialog());
		this.page.add_menu_item(__("Re-sync Date Range"), () => this._show_resync_dialog());
		this.page.add_menu_item(__("Repair Missing Checkins"), () => this._repair_checkins());
		this.page.add_menu_item(__("Biometrics Settings"), () => frappe.set_route("Form", "Biometrics Settings"));
	}

	/* ── Filters + date presets ─────────────────────────────────────── */
	_setup_filters() {
		this.f_from = this.page.add_field({
			fieldname: "date_from", label: __("From"), fieldtype: "Date",
			default: this.today,
			change: () => { this.filters.date_from = this.f_from.get_value() || this.today; this._load_all(); },
		});
		this.f_to = this.page.add_field({
			fieldname: "date_to", label: __("To"), fieldtype: "Date",
			default: this.today,
			change: () => { this.filters.date_to = this.f_to.get_value() || this.today; this._load_all(); },
		});
		this.f_emp = this.page.add_field({
			fieldname: "employee", label: __("Employee"), fieldtype: "Link", options: "Employee",
			change: () => { this.filters.employee = this.f_emp.get_value(); this._load_all(); },
		});
		this.f_dept = this.page.add_field({
			fieldname: "department", label: __("Department"), fieldtype: "Link", options: "Department",
			change: () => { this.filters.department = this.f_dept.get_value(); this._load_all(); },
		});
	}

	_set_dates(from, to) {
		this.filters.date_from = from;
		this.filters.date_to   = to;
		this.f_from.set_value(from);
		this.f_to.set_value(to);
		this._load_all();
	}

	/* ── Layout ─────────────────────────────────────────────────────── */
	_render_layout() {
		const today      = this.today;
		const yesterday  = frappe.datetime.add_days(today, -1);
		const week_start = frappe.datetime.add_days(today, -((new Date().getDay() + 6) % 7));
		const month_start = today.substring(0, 8) + "01";
		const last_month_end   = frappe.datetime.add_days(month_start, -1);
		const last_month_start = last_month_end.substring(0, 8) + "01";

		$(this.page.main).html(`
		<div class="bm-page">

			<!-- Date presets (feature 2) -->
			<div class="bm-presets">
				<span class="bm-preset-label">${__("Quick:")}</span>
				<button class="bm-preset" data-from="${today}"           data-to="${today}">${__("Today")}</button>
				<button class="bm-preset" data-from="${yesterday}"       data-to="${yesterday}">${__("Yesterday")}</button>
				<button class="bm-preset" data-from="${week_start}"      data-to="${today}">${__("This Week")}</button>
				<button class="bm-preset" data-from="${month_start}"     data-to="${today}">${__("This Month")}</button>
				<button class="bm-preset" data-from="${last_month_start}" data-to="${last_month_end}">${__("Last Month")}</button>
				<span class="bm-refresh-status" id="bm-refresh-status"></span>
			</div>

			<!-- Device alert banner (feature 9) -->
			<div id="bm-alert-banner"></div>

			<!-- Stats row -->
			<div class="bm-stats-row" id="bm-stats">${this._stat_skeleton(6)}</div>

			<!-- Charts row -->
			<div class="bm-charts-row">
				<div class="bm-card bm-chart-card">
					<div class="bm-card-header">
						<span class="bm-card-title">${__("Punch Trend")}</span>
						<span class="bm-card-sub">${__("Last 7 days")}</span>
					</div>
					<div id="bm-trend-chart" class="bm-chart-area"></div>
				</div>
				<div class="bm-side-charts">
					<div class="bm-card bm-chart-card">
						<div class="bm-card-header"><span class="bm-card-title">${__("Punches by Hour")}</span></div>
						<div id="bm-hour-chart" class="bm-chart-area bm-chart-sm"></div>
					</div>
					<div class="bm-card bm-device-summary">
						<div class="bm-card-header"><span class="bm-card-title">${__("Attendance Summary")}</span></div>
						<div id="bm-attend-summary"></div>
					</div>
				</div>
			</div>

			<!-- Employee IN/OUT (features 1, 3, 7) -->
			<div class="bm-card bm-table-card">
				<div class="bm-card-header">
					<span class="bm-card-title">${__("Employee IN / OUT")}</span>
					<div class="bm-header-actions">
						<span class="bm-card-sub" id="bm-inout-sub"></span>
						<!-- Filter tabs (feature 3) -->
						<div class="bm-tabs" id="bm-inout-tabs">
							<button class="bm-tab active" data-filter="all">${__("All")}</button>
							<button class="bm-tab" data-filter="present">${__("Present")}</button>
							<button class="bm-tab" data-filter="absent">${__("Absent")}</button>
							<button class="bm-tab bm-tab-warn" data-filter="missing_out">${__("Missing OUT")}</button>
							<button class="bm-tab bm-tab-warn" data-filter="late">${__("Late")}</button>
						</div>
						<input class="bm-search" id="bm-inout-search" placeholder="${__("Search…")}" type="search">
						<button class="bm-export-btn" id="bm-export-btn" title="${__("Export to CSV")}">⬇ CSV</button>
					</div>
				</div>
				<div class="bm-table-wrap" id="bm-inout-table">${this._table_skeleton()}</div>
			</div>

			<!-- Recent punch activity -->
			<div class="bm-card bm-table-card">
				<div class="bm-card-header">
					<span class="bm-card-title">${__("Recent Punch Activity")}</span>
					<input class="bm-search" id="bm-txn-search" placeholder="${__("Search…")}" type="search">
				</div>
				<div class="bm-table-wrap" id="bm-txn-table">${this._table_skeleton()}</div>
			</div>

		</div>`);

		// Preset buttons
		const me = this;
		$(this.page.main).on("click", ".bm-preset", function () {
			$(".bm-preset").removeClass("active");
			$(this).addClass("active");
			me._set_dates($(this).data("from"), $(this).data("to"));
		});

		// Tab filter
		$(this.page.main).on("click", ".bm-tab", function () {
			$(".bm-tab").removeClass("active");
			$(this).addClass("active");
			me._apply_inout_tab($(this).data("filter"));
		});

		// Export button (feature 6)
		$(this.page.main).on("click", "#bm-export-btn", () => this._export_csv());

		// Live search
		this._wire_search("#bm-inout-search", "#bm-inout-table", "tr.bm-row");
		this._wire_search("#bm-txn-search",   "#bm-txn-table",   "tr.bm-row");
	}

	/* ── Data loaders ───────────────────────────────────────────────── */
	_load_all() {
		this._load_summary();
		this._load_trend();
		this._load_hourly();
		this._load_inout();
		this._load_transactions();
		this._load_device_alerts();
	}

	_call(method, args, cb) {
		frappe.call({
			method: `biometrics.biometrics.page.biometrics_dashboard.biometrics_dashboard.${method}`,
			args: { ...this.filters, ...args },
			callback: (r) => r.message !== undefined && cb(r.message),
		});
	}

	_load_summary()       { this._call("get_summary",        {}, (d) => this._render_stats(d)); }
	_load_trend()         { this._call("get_punch_trend",    { days: 7 }, (d) => this._render_trend(d)); }
	_load_hourly()        { this._call("get_hourly_heatmap", {}, (d) => this._render_hourly(d)); }
	_load_transactions()  { this._call("get_recent_transactions", { limit: 100 }, (d) => this._render_transactions(d)); }
	_load_device_alerts() { this._call("get_device_alerts",  {}, (d) => this._render_device_alerts(d)); }

	_load_inout() {
		this._call("get_employee_inout", {}, (d) => {
			this._inout_data = d;
			this._inout_rows = d.rows || [];
			this._render_inout(d);
		});
	}

	/* ── Sync Now (feature 4) ───────────────────────────────────────── */
	_trigger_sync() {
		frappe.call({
			method: "biometrics.biometrics.page.biometrics_dashboard.biometrics_dashboard.trigger_sync",
			freeze: true,
			freeze_message: __("Queuing sync…"),
			callback: (r) => {
				if (r.message) {
					frappe.show_alert({ message: r.message.message, indicator: "blue" });
					setTimeout(() => this._load_all(), 4000);
				}
			},
		});
	}

	/* ── Auto-refresh (feature 5) ───────────────────────────────────── */
	_toggle_auto_refresh() {
		if (this._auto_refresh_timer) {
			clearInterval(this._auto_refresh_timer);
			this._auto_refresh_timer = null;
			$("#bm-refresh-status").text("");
			// Update menu label
			$(".dropdown-item:contains('Auto-Refresh')").text(__("Auto-Refresh: OFF"));
			frappe.show_alert({ message: __("Auto-refresh disabled"), indicator: "gray" });
		} else {
			this._start_auto_refresh(5);
			$(".dropdown-item:contains('Auto-Refresh')").text(__("Auto-Refresh: ON (5 min)"));
			frappe.show_alert({ message: __("Auto-refresh every 5 minutes enabled"), indicator: "green" });
		}
	}

	_start_auto_refresh(minutes = 5) {
		this._auto_refresh_remaining = minutes * 60;
		this._auto_refresh_timer = setInterval(() => {
			this._auto_refresh_remaining--;
			const m = Math.floor(this._auto_refresh_remaining / 60);
			const s = this._auto_refresh_remaining % 60;
			$("#bm-refresh-status").html(
				`<span class="bm-countdown">🔄 ${m}:${String(s).padStart(2, "0")}</span>`
			);
			if (this._auto_refresh_remaining <= 0) {
				this._load_all();
				this._auto_refresh_remaining = minutes * 60;
			}
		}, 1000);
	}

	/* ── Stats (feature 9 device count) ────────────────────────────── */
	_render_stats(d) {
		const fmt    = (n) => frappe.utils.formatNumber(n || 0);
		const pct    = d.enrolled      ? Math.round((d.enrolled      / d.total_active)    * 100) : 0;
		const chkPct = d.punches_period ? Math.round((d.checkins_period / d.punches_period) * 100) : 0;
		const lastSync = d.last_transaction_sync
			? frappe.datetime.comment_when(d.last_transaction_sync) : __("Never");

		const stats = [
			{
				icon: "👥", value: fmt(d.enrolled),
				label: __("Enrolled Employees"),
				sub: `${pct}% of ${fmt(d.total_active)} active`, color: "blue",
				link: () => frappe.set_route("List", "Employee", { attendance_device_id: ["is", "set"] }),
			},
			{
				icon: "⚠️", value: fmt(d.not_enrolled),
				label: __("Missing Device ID"),
				sub: __("Click to view list"), color: d.not_enrolled ? "orange" : "green",
				link: () => frappe.call({
					method: "biometrics.biometrics.api.endpoints.get_employees_missing_device_id",
					callback: (r) => this._show_missing_emp_dialog(r.message),
				}),
			},
			{
				icon: "📡", value: `${fmt(d.devices_online)} / ${fmt(d.devices_total)}`,
				label: __("Devices Online"),
				sub: `${fmt(d.devices_offline)} offline`, color: d.devices_offline ? "orange" : "green",
				link: () => frappe.set_route("List", "Biometrics Device"),
			},
			{
				icon: "👆", value: fmt(d.punches_period),
				label: __("Punches (Period)"),
				sub: `${fmt(d.unmatched_period)} unmatched`, color: "teal",
				link: () => frappe.set_route("List", "Biometrics Transaction Log"),
			},
			{
				icon: "✅", value: fmt(d.checkins_period),
				label: __("Checkins Created"),
				sub: `${chkPct}% of punches`, color: chkPct < 90 ? "orange" : "green",
				link: () => frappe.set_route("List", "Employee Checkin"),
			},
			{
				icon: d.auto_sync ? "🔄" : "⏸️", value: d.auto_sync ? __("Active") : __("Off"),
				label: __("Auto Sync"),
				sub: `${__("Last")}: ${lastSync}`, color: d.auto_sync ? "green" : "gray",
				link: () => frappe.set_route("Form", "Biometrics Settings"),
			},
		];

		$("#bm-stats").html(stats.map((s) => `
			<div class="bm-stat-card bm-stat-${s.color}">
				<div class="bm-stat-icon">${s.icon}</div>
				<div class="bm-stat-value">${s.value}</div>
				<div class="bm-stat-label">${s.label}</div>
				<div class="bm-stat-sub">${s.sub}</div>
			</div>`).join(""));

		$("#bm-stats .bm-stat-card").each(function (i) {
			$(this).on("click", () => stats[i].link && stats[i].link());
		});
	}

	/* ── Punch trend chart ──────────────────────────────────────────── */
	_render_trend(rows) {
		if (!rows.length) { $("#bm-trend-chart").html(this._empty_state(__("No data"))); return; }
		const labels     = rows.map((r) => frappe.datetime.str_to_user(r.punch_date));
		const punchData  = rows.map((r) => r.punch_count);
		const checkinData = rows.map((r) => r.checkin_count || 0);
		if (this.charts.trend) {
			this.charts.trend.update({ labels, datasets: [{ values: punchData }, { values: checkinData }] });
			return;
		}
		this.charts.trend = new frappe.Chart("#bm-trend-chart", {
			type: "bar",
			data: { labels, datasets: [
				{ name: __("Punches"),  values: punchData,   chartType: "bar" },
				{ name: __("Checkins"), values: checkinData, chartType: "line" },
			]},
			colors: ["#2490EF", "#28a745"], height: 200, animate: true,
			barOptions: { spaceRatio: 0.3 },
		});
	}

	/* ── Hourly heatmap ─────────────────────────────────────────────── */
	_render_hourly(rows) {
		const byHour = {};
		rows.forEach((r) => (byHour[r.hour_of_day] = r.punch_count));
		const labels = [], vals = [];
		for (let h = 0; h < 24; h++) {
			labels.push(h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`);
			vals.push(byHour[h] || 0);
		}
		if (!vals.some((v) => v > 0)) { $("#bm-hour-chart").html(this._empty_state(__("No data"))); return; }
		if (this.charts.hourly) { this.charts.hourly.update({ labels, datasets: [{ values: vals }] }); return; }
		this.charts.hourly = new frappe.Chart("#bm-hour-chart", {
			type: "bar",
			data: { labels, datasets: [{ name: __("Punches"), values: vals }] },
			colors: ["#7575ff"], height: 130, animate: true,
			barOptions: { spaceRatio: 0.15 }, axisOptions: { xIsSeries: true },
		});
	}

	/* ── Device alert banner (feature 9) ────────────────────────────── */
	_render_device_alerts(d) {
		if (!d.alerts || !d.alerts.length) { $("#bm-alert-banner").html(""); return; }
		const items = d.alerts.map((a) => `
			<span class="bm-alert-item bm-alert-${a.severity}">
				📡 <b>${a.device}</b> — ${a.message}
			</span>`).join("");
		$("#bm-alert-banner").html(`
			<div class="bm-alert-banner">
				<span class="bm-alert-icon">⚠️</span>
				<span class="bm-alert-title">${__("Device Alert")}</span>
				${items}
				<a href="/app/biometrics-device" class="bm-alert-link">${__("View Devices →")}</a>
			</div>`);
	}

	/* ── Attendance summary sidebar ─────────────────────────────────── */
	_render_attend_summary(rows) {
		const total    = rows.length || 1;
		const present  = rows.filter((r) => r.status === "Present").length;
		const absent   = rows.filter((r) => r.status === "Absent").length;
		const onlyIn   = rows.filter((r) => r.first_in && !r.last_out && r.status === "Present").length;
		const complete = rows.filter((r) => r.first_in && r.last_out).length;
		const late     = rows.filter((r) => r.is_late).length;
		const early    = rows.filter((r) => r.left_early).length;

		const bar = (label, count, cls) => `
			<div class="bm-health-row">
				<span class="bm-health-label">${label}</span>
				<div class="bm-health-bar-wrap">
					<div class="bm-health-bar ${cls}" style="width:${Math.round((count / total) * 100)}%"></div>
				</div>
				<span class="bm-health-count">${count}</span>
			</div>`;

		$("#bm-attend-summary").html(
			rows.length
				? bar(__("Present"),  present,  "bm-bar-green") +
				  bar(__("Absent"),   absent,   "bm-bar-gray")  +
				  bar(__("IN only"),  onlyIn,   "bm-bar-blue")  +
				  bar(__("IN & OUT"), complete, "bm-bar-teal")  +
				  bar(__("Late"),     late,     "bm-bar-orange") +
				  bar(__("Left Early"), early,  "bm-bar-red") +
				  `<div class="bm-health-footer">${__("{0} enrolled", [rows.length])}</div>`
				: this._empty_state(__("No enrolled employees"))
		);
	}

	/* ── Employee IN/OUT table (features 1, 3, 7) ───────────────────── */
	_render_inout(d) {
		const rows       = d.rows || [];
		const shiftStart = d.shift_start || "08:00";
		const shiftEnd   = d.shift_end   || "17:00";

		this._render_attend_summary(rows);

		const present = rows.filter((r) => r.status === "Present").length;
		const absent  = rows.length - present;
		const missing = rows.filter((r) => r.missing_out).length;
		const late    = rows.filter((r) => r.is_late).length;

		$("#bm-inout-sub").text(__("{0} present · {1} absent", [present, absent]));

		// Update tab badges
		$(".bm-tab[data-filter='missing_out']").text(`${__("Missing OUT")} ${missing ? `(${missing})` : ""}`);
		$(".bm-tab[data-filter='late']").text(`${__("Late")} ${late ? `(${late})` : ""}`);

		if (!rows.length) {
			$("#bm-inout-table").html(this._empty_state(__("No employees with Attendance Device ID found")));
			return;
		}

		const fmt_time = (dt) => {
			if (!dt) return "—";
			const p = frappe.datetime.str_to_user(dt).split(" ");
			return p.length > 1 ? p.slice(1).join(" ") : p[0];
		};

		const fmt_hrs = (mins) => {
			if (!mins && mins !== 0) return "—";
			const h = Math.floor(mins / 60), m = mins % 60;
			return `${h}h ${String(m).padStart(2, "0")}m`;
		};

		const status_badge = (r) => {
			if (r.status === "Absent") return `<span class="bm-badge bm-badge-gray">${__("Absent")}</span>`;
			if (r.first_in && r.last_out) return `<span class="bm-badge bm-badge-green">${__("IN & OUT")}</span>`;
			if (r.first_in) return `<span class="bm-badge bm-badge-blue">${__("IN")}</span>`;
			return `<span class="bm-badge bm-badge-orange">${__("OUT only")}</span>`;
		};

		const flag_badges = (r) => {
			let b = "";
			if (r.is_late)     b += `<span class="bm-flag bm-flag-orange" title="${__("Late arrival — after {0}", [shiftStart])}">${__("Late")}</span>`;
			if (r.left_early)  b += `<span class="bm-flag bm-flag-red"    title="${__("Left early — before {0}", [shiftEnd])}">${__("Early out")}</span>`;
			if (r.missing_out) b += `<span class="bm-flag bm-flag-warn"   title="${__("No OUT punch recorded")}">${__("Missing OUT")}</span>`;
			return b;
		};

		const rows_html = rows.map((r) => `
			<tr class="bm-row ${r.status === "Absent" ? "bm-row-absent" : ""} ${r.missing_out ? "bm-row-missing" : ""}"
				data-status="${r.status}"
				data-missing="${r.missing_out ? "1" : "0"}"
				data-late="${r.is_late ? "1" : "0"}">
				<td>
					<div class="bm-emp-cell">
						<div class="bm-emp-avatar ${r.status === "Absent" ? "bm-avatar-gray" : ""}">${(r.employee_name || "?")[0].toUpperCase()}</div>
						<div>
							<div class="bm-emp-name"><a href="/app/employee/${r.employee}">${r.employee_name || r.employee}</a></div>
							<div class="bm-emp-id">${r.attendance_device_id}</div>
						</div>
					</div>
				</td>
				<td>${r.department || "—"}</td>
				<td class="bm-time-cell bm-in">${fmt_time(r.first_in)}</td>
				<td class="bm-time-cell bm-out">${fmt_time(r.last_out)}</td>
				<td class="bm-hours-cell">${fmt_hrs(r.working_minutes)}</td>
				<td class="bm-center"><span class="bm-punch-count">${r.total_punches || 0}</span></td>
				<td>${status_badge(r)} ${flag_badges(r)}</td>
				<td>
					<button class="bm-action-btn" data-emp="${r.employee}" title="${__("Sync logs for this employee")}">⟳</button>
				</td>
			</tr>`).join("");

		$("#bm-inout-table").html(`
			<table class="bm-table">
				<thead>
					<tr>
						<th>${__("Employee")}</th>
						<th>${__("Department")}</th>
						<th>${__("First IN")} <span class="bm-th-sub">(shift ${shiftStart})</span></th>
						<th>${__("Last OUT")} <span class="bm-th-sub">(shift ${shiftEnd})</span></th>
						<th>${__("Hours Worked")}</th>
						<th>${__("Punches")}</th>
						<th>${__("Status / Flags")}</th>
						<th></th>
					</tr>
				</thead>
				<tbody>${rows_html}</tbody>
			</table>
			<div class="bm-table-footer">
				${__("{0} enrolled · {1} present · {2} absent · {3} missing OUT · {4} late",
					[rows.length, present, absent, missing, late])}
			</div>`);

		const me = this;
		$("#bm-inout-table .bm-action-btn").on("click", function () {
			me._show_employee_sync_dialog($(this).data("emp"));
		});
	}

	_apply_inout_tab(filter) {
		const rows = $("#bm-inout-table tr.bm-row");
		rows.each(function () {
			const $r = $(this);
			let show = true;
			if (filter === "present")     show = $r.data("status") === "Present";
			if (filter === "absent")      show = $r.data("status") === "Absent";
			if (filter === "missing_out") show = $r.data("missing") === "1";
			if (filter === "late")        show = $r.data("late")    === "1";
			$r.toggle(show);
		});
	}

	/* ── Recent transactions ────────────────────────────────────────── */
	_render_transactions(rows) {
		if (!rows.length) { $("#bm-txn-table").html(this._empty_state(__("No punch records for the selected period"))); return; }
		const v_icon = (v) => ({ 1: "👆", 4: "💳", 15: "😀" })[v] || "❓";
		const rows_html = rows.map((r) => `
			<tr class="bm-row ${!r.erpnext_employee ? "bm-row-warn" : ""}">
				<td class="bm-time-col">
					<div class="bm-punch-time">${frappe.datetime.str_to_user(r.punch_time).split(" ").pop()}</div>
					<div class="bm-punch-date">${frappe.datetime.str_to_user(r.punch_time).split(" ")[0]}</div>
				</td>
				<td>
					${r.erpnext_employee
						? `<a href="/app/employee/${r.erpnext_employee}" class="bm-link">${r.employee_name || r.emp_code}</a>`
						: `<span class="bm-unmatched">${r.emp_code}</span>`}
					${r.department ? `<div class="bm-row-sub">${r.department}</div>` : ""}
				</td>
				<td>${r.device_alias || "—"}</td>
				<td>${r.area_alias || "—"}</td>
				<td>${r.log_type === "IN" ? `<span class="bm-badge bm-badge-green">IN</span>`
					: r.log_type === "OUT" ? `<span class="bm-badge bm-badge-red">OUT</span>`
					: `<span class="bm-badge bm-badge-gray">—</span>`}</td>
				<td class="bm-center">${v_icon(r.verify_type)}</td>
				<td class="bm-center">
					${r.checkin_created
						? `<a href="/app/employee-checkin/${r.employee_checkin}" class="bm-badge bm-badge-green">✓</a>`
						: r.error_message
						? `<span class="bm-badge bm-badge-red" title="${r.error_message}">✗</span>`
						: `<span class="bm-badge bm-badge-gray">—</span>`}
				</td>
				<td><a href="/app/biometrics-transaction-log/${r.name}" class="bm-icon-btn">↗</a></td>
			</tr>`).join("");

		$("#bm-txn-table").html(`
			<table class="bm-table">
				<thead><tr>
					<th>${__("Time")}</th><th>${__("Employee")}</th>
					<th>${__("Device")}</th><th>${__("Area")}</th>
					<th>${__("Type")}</th>
					<th title="${__("👆 Fingerprint · 💳 Card · 😀 Face")}">${__("Mode")}</th>
					<th>${__("Checkin")}</th><th></th>
				</tr></thead>
				<tbody>${rows_html}</tbody>
			</table>
			<div class="bm-table-footer">${__("Showing {0} records", [rows.length])}</div>`);
	}

	/* ── Export CSV (feature 6) ─────────────────────────────────────── */
	_export_csv() {
		const rows = this._inout_rows;
		if (!rows || !rows.length) { frappe.msgprint(__("No data to export")); return; }

		const fmt = (dt) => dt ? frappe.datetime.str_to_user(dt) : "";
		const hrs = (m) => m ? `${Math.floor(m/60)}h ${m%60}m` : "";

		const headers = [
			"Employee ID", "Employee Name", "Department", "Designation",
			"Device ID", "First IN", "Last OUT", "Working Hours",
			"Total Punches", "Status", "Late", "Missing OUT", "Left Early"
		];

		const csv_rows = rows.map((r) => [
			r.employee, r.employee_name, r.department, r.designation,
			r.attendance_device_id,
			fmt(r.first_in), fmt(r.last_out), hrs(r.working_minutes),
			r.total_punches, r.status,
			r.is_late ? "Yes" : "No",
			r.missing_out ? "Yes" : "No",
			r.left_early ? "Yes" : "No",
		].map((v) => `"${String(v || "").replace(/"/g, '""')}"`).join(","));

		const csv = [headers.join(","), ...csv_rows].join("\n");
		const blob = new Blob([csv], { type: "text/csv" });
		const url  = URL.createObjectURL(blob);
		const a    = document.createElement("a");
		a.href     = url;
		a.download = `biometrics_inout_${this.filters.date_from}_to_${this.filters.date_to}.csv`;
		a.click();
		URL.revokeObjectURL(url);
	}

	/* ── Monthly summary dialog (feature 8) ─────────────────────────── */
	_show_monthly_dialog() {
		const today = frappe.datetime.get_today();
		const d = new frappe.ui.Dialog({
			title: __("Monthly Attendance Summary"),
			fields: [
				{ label: __("Month"), fieldname: "year_month", fieldtype: "Data",
					default: today.substring(0, 7), description: __("Format: YYYY-MM") },
				{ fieldtype: "Column Break" },
				{ label: __("Department"), fieldname: "department", fieldtype: "Link", options: "Department" },
			],
			primary_action_label: __("Generate"),
			primary_action: (vals) => {
				d.hide();
				frappe.call({
					method: "biometrics.biometrics.page.biometrics_dashboard.biometrics_dashboard.get_monthly_summary",
					args: { year_month: vals.year_month, department: vals.department || "" },
					freeze: true,
					freeze_message: __("Generating summary…"),
					callback: (r) => {
						if (!r.message) return;
						const m = r.message;
						this._monthly_rows = m.rows || [];
						if (!m.rows.length) { frappe.msgprint(__("No data found")); return; }
						this._show_monthly_table(m);
					},
				});
			},
		});
		d.show();
	}

	_show_monthly_table(m) {
		const color = (pct) => pct >= 90 ? "#28a745" : pct >= 75 ? "#f4842b" : "#e74c3c";
		const rows = m.rows.map((r) => `
			<tr>
				<td><a href="/app/employee/${r.employee}">${r.employee_name}</a>
					<div style="font-size:11px;color:#6c757d">${r.department}</div></td>
				<td style="text-align:center;font-weight:700;color:${color(r.attendance_pct)}">${r.attendance_pct}%</td>
				<td style="text-align:center;color:#28a745">${r.days_present}</td>
				<td style="text-align:center;color:#e74c3c">${r.days_absent}</td>
				<td style="text-align:center">${r.total_punches}</td>
				<td style="text-align:center">${r.avg_working_hours}</td>
			</tr>`).join("");

		const report = new frappe.ui.Dialog({
			title: __("Monthly Summary — {0} ({1} working days)", [m.year_month, m.days_in_month]),
			size: "large",
			fields: [{
				fieldtype: "HTML",
				options: `
					<div style="text-align:right;margin-bottom:8px">
						<button class="btn btn-sm btn-default" id="bm-export-monthly">⬇ Export CSV</button>
					</div>
					<div style="max-height:500px;overflow:auto">
					<table class="table table-bordered table-condensed" style="font-size:13px">
						<thead style="background:#f8f9fa">
							<tr>
								<th>${__("Employee")}</th>
								<th style="text-align:center">${__("Attendance %")}</th>
								<th style="text-align:center">${__("Days Present")}</th>
								<th style="text-align:center">${__("Days Absent")}</th>
								<th style="text-align:center">${__("Total Punches")}</th>
								<th style="text-align:center">${__("Avg Working Hours")}</th>
							</tr>
						</thead>
						<tbody>${rows}</tbody>
					</table></div>`,
			}],
		});
		report.show();
		report.$wrapper.find("#bm-export-monthly").on("click", () => this._export_monthly_csv(m));
	}

	_export_monthly_csv(m) {
		const headers = ["Employee", "Employee Name", "Department", "Days Present", "Days Absent", "Attendance %", "Total Punches", "Avg Working Hours"];
		const csv_rows = m.rows.map((r) => [
			r.employee, r.employee_name, r.department,
			r.days_present, r.days_absent, r.attendance_pct,
			r.total_punches, r.avg_working_hours,
		].map((v) => `"${String(v || "").replace(/"/g, '""')}"`).join(","));
		const csv  = [headers.join(","), ...csv_rows].join("\n");
		const blob = new Blob([csv], { type: "text/csv" });
		const url  = URL.createObjectURL(blob);
		const a    = document.createElement("a");
		a.href     = url;
		a.download = `biometrics_monthly_${m.year_month}.csv`;
		a.click();
		URL.revokeObjectURL(url);
	}

	/* ── Employee sync dialog ───────────────────────────────────────── */
	_show_employee_sync_dialog(employee = "") {
		const today = frappe.datetime.get_today();
		const d = new frappe.ui.Dialog({
			title: __("Sync Attendance Logs for Employee"),
			fields: [
				{ label: __("Employee"), fieldname: "employee", fieldtype: "Link",
					options: "Employee", default: employee, filters: { status: "Active" }, reqd: 1 },
				{ fieldtype: "Column Break" },
				{ label: __("From Date"), fieldname: "date_from", fieldtype: "Date",
					default: frappe.datetime.add_days(today, -7), reqd: 1 },
				{ label: __("To Date"), fieldname: "date_to", fieldtype: "Date", default: today, reqd: 1 },
				{ fieldtype: "HTML", options: `<p class="text-muted" style="font-size:12px;margin-top:8px">
					Fetches punch records from the machine for this employee. Duplicates are skipped.
				</p>` },
			],
			primary_action_label: __("Sync Now"),
			primary_action: (vals) => {
				d.hide();
				frappe.call({
					method: "biometrics.biometrics.api.endpoints.sync_employee_logs",
					args: vals, freeze: true, freeze_message: __("Fetching logs…"),
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
								${m.errors && m.errors.length ? `<hr><b>${__("Errors")}:</b><br>${m.errors.join("<br>")}` : ""}`,
							indicator: m.created > 0 ? "green" : "blue",
						});
						this._load_all();
					},
				});
			},
		});
		d.show();
	}

	/* ── Re-sync date range dialog ──────────────────────────────────── */
	_show_resync_dialog() {
		const today = frappe.datetime.get_today();
		const d = new frappe.ui.Dialog({
			title: __("Re-sync All Employees — Date Range"),
			fields: [
				{ label: __("From Date"), fieldname: "date_from", fieldtype: "Date",
					default: frappe.datetime.add_days(today, -7), reqd: 1 },
				{ label: __("To Date"), fieldname: "date_to", fieldtype: "Date", default: today, reqd: 1 },
				{ fieldtype: "HTML", options: `<p class="text-muted" style="font-size:12px;margin-top:8px">
					Re-pulls transactions for all enrolled employees. Runs as a background job.
				</p>` },
			],
			primary_action_label: __("Queue Re-sync"),
			primary_action: (vals) => {
				d.hide();
				frappe.call({
					method: "biometrics.biometrics.api.endpoints.resync_date_range",
					args: vals, freeze: true, freeze_message: __("Queuing…"),
					callback: (r) => { if (r.message) frappe.msgprint({ message: r.message.message, indicator: "blue" }); },
				});
			},
		});
		d.show();
	}

	/* ── Repair checkins ────────────────────────────────────────────── */
	_repair_checkins() {
		frappe.confirm(__("Create Employee Checkins for all transaction logs that have an ERPNext employee but no checkin yet?"), () => {
			frappe.call({
				method: "biometrics.biometrics.api.endpoints.repair_employee_checkins",
				freeze: true, freeze_message: __("Repairing…"),
				callback: (r) => {
					if (!r.message) return;
					const m = r.message;
					frappe.msgprint({
						title: __("Repair Complete"),
						message: __("Created: {0} · Already existed: {1} · Failed: {2}", [m.created, m.skipped, m.failed]),
						indicator: m.created > 0 ? "green" : "blue",
					});
					this._load_all();
				},
			});
		});
	}

	_show_missing_emp_dialog(list) {
		if (!list || !list.length) { frappe.msgprint({ message: __("All active employees have an Attendance Device ID."), indicator: "green" }); return; }
		const rows = list.map((e) => `<tr><td>${e.name}</td><td>${e.employee_name}</td><td>${e.department || "—"}</td>
			<td><a href="/app/employee/${e.name}" target="_blank">Edit ↗</a></td></tr>`).join("");
		frappe.msgprint({
			title: __("{0} Employee(s) Missing Attendance Device ID", [list.length]),
			message: `<div style="max-height:300px;overflow:auto">
				<table class="table table-bordered table-condensed" style="font-size:12px">
					<thead><tr><th>ID</th><th>Name</th><th>Department</th><th></th></tr></thead>
					<tbody>${rows}</tbody>
				</table></div>`,
			indicator: "orange",
		});
	}

	/* ── Helpers ────────────────────────────────────────────────────── */
	_wire_search(inp, tbl, row_sel) {
		$(this.page.main).on("input", inp, function () {
			const q = $(this).val().toLowerCase();
			$(tbl).find(row_sel).each(function () {
				$(this).toggle(!q || $(this).text().toLowerCase().includes(q));
			});
		});
	}

	_stat_skeleton(n) { return Array(n).fill(`<div class="bm-stat-card bm-skeleton"></div>`).join(""); }
	_table_skeleton() {
		return `<div class="bm-skeleton-table">${Array(5).fill('<div class="bm-skeleton-row"></div>').join("")}</div>`;
	}
	_empty_state(msg) { return `<div class="bm-empty">${msg}</div>`; }

	/* ── Styles ─────────────────────────────────────────────────────── */
	_inject_styles() {
		if ($("#bm-styles").length) return;
		$("head").append(`<style id="bm-styles">
.bm-page { padding: 12px 20px 40px; font-family: var(--font-stack); }

/* Date presets (feature 2) */
.bm-presets {
	display: flex; align-items: center; gap: 6px;
	margin-bottom: 14px; flex-wrap: wrap;
}
.bm-preset-label { font-size: 11px; color: var(--text-muted); font-weight: 600; text-transform: uppercase; }
.bm-preset {
	border: 1px solid var(--border-color); background: #fff;
	border-radius: 20px; padding: 3px 12px; font-size: 12px;
	cursor: pointer; transition: all .15s; color: var(--text-color);
}
.bm-preset:hover, .bm-preset.active {
	background: #2490EF; color: #fff; border-color: #2490EF;
}
.bm-countdown { font-size: 11px; color: #2490EF; font-weight: 600; margin-left: 8px; }
.bm-refresh-status { margin-left: auto; }

/* Alert banner (feature 9) */
.bm-alert-banner {
	background: #fff3cd; border: 1px solid #ffc107; border-radius: 8px;
	padding: 10px 16px; margin-bottom: 14px;
	display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
	font-size: 13px;
}
.bm-alert-icon  { font-size: 18px; }
.bm-alert-title { font-weight: 700; color: #856404; }
.bm-alert-item  { padding: 2px 8px; border-radius: 4px; font-size: 12px; }
.bm-alert-high  { background: #f8d7da; color: #721c24; }
.bm-alert-medium { background: #fff3cd; color: #856404; }
.bm-alert-link  { margin-left: auto; color: #2490EF; font-size: 12px; text-decoration: none; white-space: nowrap; }

/* Stats row */
.bm-stats-row { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 14px; margin-bottom: 20px; }
.bm-stat-card {
	background: #fff; border-radius: 12px; padding: 18px 16px 14px;
	box-shadow: 0 1px 4px rgba(0,0,0,.08); cursor: pointer;
	transition: transform .15s, box-shadow .15s; border-top: 4px solid transparent;
}
.bm-stat-card:hover { transform: translateY(-2px); box-shadow: 0 4px 14px rgba(0,0,0,.12); }
.bm-stat-icon  { font-size: 22px; margin-bottom: 6px; }
.bm-stat-value { font-size: 26px; font-weight: 700; line-height: 1.1; }
.bm-stat-label { font-size: 12px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: .4px; margin-top: 4px; }
.bm-stat-sub   { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
.bm-stat-blue   { border-color: #2490EF; }
.bm-stat-green  { border-color: #28a745; }
.bm-stat-orange { border-color: #f4842b; }
.bm-stat-teal   { border-color: #17a2b8; }
.bm-stat-red    { border-color: #e74c3c; }
.bm-stat-gray   { border-color: #adb5bd; }

/* Charts */
.bm-charts-row { display: grid; grid-template-columns: 1fr 340px; gap: 14px; margin-bottom: 20px; }
.bm-side-charts { display: flex; flex-direction: column; gap: 14px; }
.bm-card { background: #fff; border-radius: 12px; box-shadow: 0 1px 4px rgba(0,0,0,.08); overflow: hidden; }
.bm-chart-card, .bm-device-summary { padding: 16px; }
.bm-card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; flex-wrap: wrap; gap: 6px; }
.bm-card-title { font-weight: 700; font-size: 14px; }
.bm-card-sub   { font-size: 11px; color: var(--text-muted); }
.bm-chart-area { min-height: 200px; }
.bm-chart-sm   { min-height: 130px; }

/* Attendance summary bars */
.bm-health-row  { display: flex; align-items: center; margin-bottom: 8px; gap: 8px; }
.bm-health-label { font-size: 12px; width: 72px; color: var(--text-muted); }
.bm-health-bar-wrap { flex: 1; background: var(--border-color); border-radius: 4px; height: 8px; }
.bm-health-bar  { height: 8px; border-radius: 4px; transition: width .4s; min-width: 2px; }
.bm-health-count { font-size: 12px; font-weight: 700; width: 28px; text-align: right; }
.bm-health-footer { font-size: 11px; color: var(--text-muted); margin-top: 4px; }
.bm-bar-green  { background: #28a745; }
.bm-bar-red    { background: #e74c3c; }
.bm-bar-gray   { background: #adb5bd; }
.bm-bar-blue   { background: #2490EF; }
.bm-bar-teal   { background: #17a2b8; }
.bm-bar-orange { background: #f4842b; }

/* Table cards */
.bm-table-card  { margin-bottom: 20px; }
.bm-table-card .bm-card-header { padding: 14px 16px 0; }
.bm-header-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.bm-table-wrap  { overflow-x: auto; }

/* Tabs (feature 3) */
.bm-tabs { display: flex; gap: 4px; }
.bm-tab {
	border: 1px solid var(--border-color); background: #fff;
	border-radius: 20px; padding: 2px 10px; font-size: 11px;
	cursor: pointer; color: var(--text-muted); transition: all .12s;
}
.bm-tab:hover  { border-color: #2490EF; color: #2490EF; }
.bm-tab.active { background: #2490EF; border-color: #2490EF; color: #fff; font-weight: 600; }
.bm-tab-warn.active { background: #f4842b; border-color: #f4842b; }

/* Table */
.bm-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.bm-table thead tr { background: var(--subtle-fg); }
.bm-table th {
	padding: 10px 12px; font-size: 11px; font-weight: 700;
	text-transform: uppercase; letter-spacing: .4px; color: var(--text-muted);
	text-align: left; white-space: nowrap; border-bottom: 1px solid var(--border-color);
}
.bm-th-sub { font-weight: 400; text-transform: none; color: #2490EF; }
.bm-table td { padding: 10px 12px; border-bottom: 1px solid var(--border-color); vertical-align: middle; }
.bm-row:hover td    { background: #f8fbff; }
.bm-row-warn td     { background: #fff9f0; }
.bm-row-absent td   { background: #fafafa; color: var(--text-muted); }
.bm-row-missing td  { background: #fff5f5; }
.bm-table-footer { padding: 8px 12px; font-size: 11px; color: var(--text-muted); text-align: right; border-top: 1px solid var(--border-color); }

/* Employee cell */
.bm-emp-cell   { display: flex; align-items: center; gap: 10px; }
.bm-emp-avatar {
	width: 30px; height: 30px; border-radius: 50%; flex-shrink: 0;
	background: linear-gradient(135deg, #2490EF, #7575ff);
	color: #fff; font-weight: 700; font-size: 13px;
	display: flex; align-items: center; justify-content: center;
}
.bm-avatar-gray { background: linear-gradient(135deg, #adb5bd, #6c757d) !important; }
.bm-emp-name a  { font-weight: 600; color: var(--text-color); text-decoration: none; }
.bm-emp-name a:hover { color: #2490EF; }
.bm-emp-id     { font-size: 11px; color: var(--text-muted); }
.bm-row-sub    { font-size: 11px; color: var(--text-muted); }
.bm-hours-cell { font-weight: 600; color: #17a2b8; font-family: var(--font-monospace, monospace); }
.bm-time-cell  { font-weight: 600; font-family: var(--font-monospace, monospace); }
.bm-in  { color: #28a745; }
.bm-out { color: #e74c3c; }
.bm-punch-count { background: var(--subtle-fg); border-radius: 20px; padding: 2px 10px; font-weight: 700; font-size: 12px; }
.bm-time-col .bm-punch-time { font-weight: 700; font-family: var(--font-monospace, monospace); }
.bm-time-col .bm-punch-date { font-size: 11px; color: var(--text-muted); }
.bm-unmatched  { color: #f4842b; font-style: italic; }
.bm-center     { text-align: center; }
.bm-link       { color: #2490EF; text-decoration: none; }
.bm-link:hover { text-decoration: underline; }
.bm-icon-btn   { color: var(--text-muted); font-size: 14px; text-decoration: none; padding: 2px 4px; }
.bm-icon-btn:hover { color: #2490EF; }

/* Flag badges (feature 7) */
.bm-flag { display: inline-block; padding: 1px 6px; border-radius: 10px; font-size: 10px; font-weight: 700; margin-left: 4px; }
.bm-flag-orange { background: #fff3cd; color: #856404; }
.bm-flag-red    { background: #f8d7da; color: #721c24; }
.bm-flag-warn   { background: #d1ecf1; color: #0c5460; }

/* Badges */
.bm-badge { display: inline-block; padding: 2px 8px; border-radius: 20px; font-size: 11px; font-weight: 700; text-decoration: none; }
.bm-badge-green  { background: #d4edda; color: #155724; }
.bm-badge-blue   { background: #cce5ff; color: #004085; }
.bm-badge-orange { background: #fff3cd; color: #856404; }
.bm-badge-red    { background: #f8d7da; color: #721c24; }
.bm-badge-gray   { background: var(--subtle-fg); color: var(--text-muted); }

/* Search + export */
.bm-search { border: 1px solid var(--border-color); border-radius: 6px; padding: 5px 10px; font-size: 12px; outline: none; width: 180px; transition: border-color .15s; }
.bm-search:focus { border-color: #2490EF; }
.bm-export-btn { border: 1px solid #28a745; background: #fff; color: #28a745; border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer; transition: all .15s; font-weight: 600; }
.bm-export-btn:hover { background: #28a745; color: #fff; }
.bm-action-btn { background: none; border: 1px solid var(--border-color); border-radius: 6px; padding: 2px 8px; cursor: pointer; font-size: 14px; color: var(--text-muted); transition: all .15s; }
.bm-action-btn:hover { background: #2490EF; color: #fff; border-color: #2490EF; }

/* Empty + skeleton */
.bm-empty { padding: 40px; text-align: center; color: var(--text-muted); font-size: 13px; }
.bm-skeleton { animation: bm-pulse 1.2s ease-in-out infinite; min-height: 100px; }
.bm-skeleton-table { padding: 12px; }
.bm-skeleton-row { height: 36px; background: var(--subtle-fg); border-radius: 6px; margin-bottom: 8px; animation: bm-pulse 1.2s ease-in-out infinite; }
@keyframes bm-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }

[data-theme="dark"] .bm-stat-card,
[data-theme="dark"] .bm-card { background: var(--card-bg); }
[data-theme="dark"] .bm-preset { background: var(--card-bg); }
[data-theme="dark"] .bm-row:hover td { background: rgba(36,144,239,.06); }
</style>`);
	}
}
