import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Input,
	matchesKey,
	truncateToWidth,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { buildPrompt, type FileDiff, parseDiff } from "./diff.ts";
import { basename } from "node:path";
import { findRepos, type Repo, settleAll } from "./repos.ts";
import { approvePR, currentUser, type Exec, GhError, listPRs, type MergeMethod, mergePR, type PR, prDiff, repoSlug, updateBranch } from "./gh.ts";

type Result = { prompt: string } | undefined;
type Screen = "list" | "files" | "diff";
type Modal = "none" | "comment" | "confirm" | "merge" | "update" | "repo" | "filter" | "users";
type Filter = "all" | "mine" | "assigned" | "review";
const FILTERS: { id: Filter; label: string }[] = [
	{ id: "all", label: "All" },
	{ id: "mine", label: "Created by me" },
	{ id: "assigned", label: "Assigned to me" },
	{ id: "review", label: "Review requested from me" },
];
type RepoPR = PR & { repo: Repo };

const clean = (s: string) => s.replace(/\t/g, "    ").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

const SPLIT_MIN_WIDTH = 100;

// Authors the user switched off. Module level so the choice survives closing and reopening /merger in this session.
const hiddenUsers = new Set<string>();
const userOf = (p: { author?: { login: string } }) => p.author?.login ?? "(unknown)";

/** ISO timestamp -> "YYYY-MM-DD HH:MM" in local time; blank if missing/invalid. */
function fmtDate(iso: string | undefined): string {
	const d = iso ? new Date(iso) : undefined;
	if (!d || isNaN(d.getTime())) return "";
	const z = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
}

class MergerView implements Component, Focusable {
	focused = false; // propagated to the comment Input (IME cursor placement)
	private screen: Screen = "list";
	private modal: Modal = "none";
	private all: RepoPR[] = [];
	private focus: Repo | undefined; // undefined = all repositories
	private filter: Filter = "all";
	private userIdx = 0;
	private menuIdx = 0; // highlighted row in the filter dropdown
	private repoIdx = 0; // highlighted row in the repo dropdown (0 = all)
	private me: string | undefined;
	private files: FileDiff[] = [];
	private prIdx = 0;
	private fileIdx = 0;
	private hunkIdx = 0;
	private scroll = 0; // diff body scroll offset
	private loading = "";
	private cancellable = true; // false while a request that changes GitHub is in flight
	private status: { text: string; kind: "error" | "success" | "info" } = { text: "", kind: "info" };
	private gen = 0; // invalidates stale async results
	private input = new Input({ prompt: "comment> " });
	private bodyRows = 10;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private repos: Repo[],
		private execFor: (r: Repo) => Exec,
		private done: (r: Result) => void,
	) {
		void this.loadPRs();
	}

	private get multi() {
		return this.repos.length > 1;
	}
	private get prs(): RepoPR[] {
		return this.all.filter((p) => (!this.focus || p.repo === this.focus) && !hiddenUsers.has(userOf(p)) && this.matches(p, this.filter));
	}
	private get users(): string[] {
		return [...new Set(this.all.map(userOf))].sort((a, b) => a.localeCompare(b));
	}
	private matches(p: RepoPR, f: Filter): boolean {
		const me = this.me;
		if (f === "all") return true;
		if (!me) return false; // unknown gh user: cannot match
		if (f === "mine") return p.author?.login === me;
		if (f === "assigned") return !!p.assignees?.some((a) => a.login === me);
		return !!p.reviewRequests?.some((r) => r.login === me);
	}
	private label(p: RepoPR): string {
		return repoSlug(p.url) ?? p.repo.name;
	}
	private ex(pr: RepoPR): Exec {
		return this.execFor(pr.repo);
	}

	// ---------- data ----------
	private async guard<T>(label: string, fn: () => Promise<T>, mutates = false): Promise<T | undefined> {
		const g = ++this.gen;
		this.loading = label;
		this.cancellable = !mutates;
		this.status = { text: "", kind: "info" };
		this.tui.requestRender();
		try {
			const v = await fn();
			return g === this.gen ? v : undefined;
		} catch (e) {
			if (g === this.gen) this.status = { text: e instanceof Error ? e.message : String(e), kind: "error" };
			return undefined;
		} finally {
			if (g === this.gen) this.loading = "";
			this.tui.requestRender();
		}
	}

	private async loadPRs() {
		const res = await this.guard(this.multi ? `Loading open pull requests from ${this.repos.length} repositories…` : "Loading open pull requests…", async () => {
			const results = await settleAll(this.repos, 6, async (repo) => {
				try {
					return (await listPRs(this.execFor(repo))).map((p): RepoPR => ({ ...p, repo }));
				} catch (e) {
					// A repo without a GitHub remote has no PRs: not an error when other repos are around.
					if (this.multi && e instanceof GhError && /no git remotes found/i.test(e.message)) return [];
					throw e;
				}
			});
			const prs: RepoPR[] = [];
			const errors: string[] = [];
			results.forEach((r, i) => {
				if (r.status === "fulfilled") prs.push(...r.value);
				else errors.push(`${this.repos[i].name}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
			});
			// Every repo failed: surface it as an error (e.g. gh missing / not logged in).
			if (errors.length === this.repos.length) throw new GhError(errors[0].replace(/^[^:]*: /, ""));
			return { prs, errors, me: await currentUser(this.execFor(this.repos[0])) };
		});
		if (!res) return;
		// PR text is untrusted: no terminal escapes
		this.all = res.prs
			.map((p) => ({ ...p, title: clean(p.title) }))
			.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")); // newest first; ISO timestamps sort as text
		this.me = res.me;
		this.prIdx = Math.min(this.prIdx, Math.max(0, this.prs.length - 1));
		if (res.errors.length) {
			const skipped = res.errors.length === 1 ? res.errors[0] : `${res.errors.length} repos skipped, first: ${res.errors[0]}`;
			this.status = { text: skipped, kind: "error" };
		} else if (!this.prs.length) this.status = { text: "No open pull requests.", kind: "info" };
	}

	private async openPR() {
		const pr = this.prs[this.prIdx];
		if (!pr) return;
		const text = await this.guard(`Loading diff of #${pr.number}…`, () => prDiff(this.ex(pr), pr.number));
		if (text === undefined) return;
		this.files = parseDiff(text);
		this.fileIdx = 0;
		this.hunkIdx = 0;
		this.scroll = 0;
		this.screen = "files";
		if (!this.files.length) this.status = { text: "This PR has no changed files.", kind: "info" };
	}

	private isOwn(pr: PR | undefined): boolean {
		return !!pr && !!this.me && pr.author?.login === this.me;
	}

	/** Open the confirm step, unless GitHub would reject it (own PR). */
	private askApprove() {
		if (this.isOwn(this.pr)) {
			this.status = { text: `#${this.pr!.number} is your own PR: GitHub does not allow approving it.`, kind: "error" };
		} else this.modal = "confirm";
	}

	private askMerge() {
		if (this.pr?.isDraft) this.status = { text: `#${this.pr.number} is a draft: mark it ready before merging.`, kind: "error" };
		else this.modal = "merge";
	}

	private async merge(method: MergeMethod) {
		const pr = this.prs[this.prIdx];
		const out = await this.guard(`Merging #${pr.number} (${method})…`, () => mergePR(this.ex(pr), pr.number, method), true);
		if (out === undefined) return;
		// merged PR is no longer open: drop it and go back to the list
		this.all.splice(this.all.indexOf(pr), 1);
		this.prIdx = Math.min(this.prIdx, Math.max(0, this.prs.length - 1));
		this.files = [];
		this.screen = "list";
		this.status = { text: `Merged #${pr.number} (${method}).`, kind: "success" };
	}

	private async approve() {
		const pr = this.prs[this.prIdx];
		const out = await this.guard(`Approving #${pr.number}…`, () => approvePR(this.ex(pr), pr.number), true);
		if (out !== undefined) this.status = { text: `Approved #${pr.number}.`, kind: "success" };
	}

	// ---------- state helpers ----------
	private get pr(): RepoPR | undefined {
		return this.prs[this.prIdx];
	}
	private get file(): FileDiff | undefined {
		return this.files[this.fileIdx];
	}
	/** Files screen: change the selected file, the right pane previews it from the top. */
	private selectFile(i: number) {
		if (!this.files.length) return;
		this.fileIdx = Math.max(0, Math.min(this.files.length - 1, i));
		this.hunkIdx = 0;
		this.scroll = 0;
	}

	private enterFile(i: number) {
		if (!this.files.length) return;
		this.fileIdx = (i + this.files.length) % this.files.length;
		this.hunkIdx = 0;
		this.scroll = 0;
		this.screen = "diff";
	}

	// ---------- input ----------
	handleInput(data: string): void {
		if (this.modal === "comment") return this.commentInput(data);
		if (this.modal === "confirm") return this.confirmInput(data);
		if (this.modal === "merge") return this.mergeInput(data);
		if (this.modal === "update") return this.updateInput(data);
		if (this.modal === "repo") return this.repoInput(data);
		if (this.modal === "filter") return this.filterInput(data);
		if (this.modal === "users") return this.userInput(data);
		if (this.loading) {
			// Esc only abandons reads. A merge/approve/update cannot be recalled once sent, so keep showing it.
			if (this.cancellable && (matchesKey(data, "escape") || matchesKey(data, "ctrl+c"))) {
				this.gen++; // abandon the in-flight request
				this.loading = "";
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, "q") || matchesKey(data, "ctrl+c")) return this.done(undefined);

		const up = matchesKey(data, "up") || matchesKey(data, "k");
		const down = matchesKey(data, "down") || matchesKey(data, "j");
		const back = matchesKey(data, "escape") || matchesKey(data, "left") || matchesKey(data, "backspace");
		const enter = matchesKey(data, "enter") || matchesKey(data, "right");

		if (this.screen === "list") {
			if (up) this.prIdx = Math.max(0, this.prIdx - 1);
			else if (down) this.prIdx = Math.min(this.prs.length - 1, this.prIdx + 1);
			else if (enter) void this.openPR();
			else if (matchesKey(data, "r")) void this.loadPRs();
			else if (matchesKey(data, "u") && this.users.length) {
				this.userIdx = 0;
				this.modal = "users";
			} else if (matchesKey(data, "v")) {
				this.menuIdx = FILTERS.findIndex((x) => x.id === this.filter);
				this.modal = "filter";
			} else if (matchesKey(data, "f") && this.multi) {
				this.repoIdx = this.focus ? this.repos.indexOf(this.focus) + 1 : 0;
				this.modal = "repo";
			}
			else if (matchesKey(data, "escape")) return this.done(undefined);
		} else if (this.screen === "files") {
			if (up) this.selectFile(this.fileIdx - 1);
			else if (down) this.selectFile(this.fileIdx + 1);
			else if (matchesKey(data, "pageDown") || matchesKey(data, "space")) this.scroll += this.bodyRows - 1;
			else if (matchesKey(data, "pageUp")) this.scroll = Math.max(0, this.scroll - (this.bodyRows - 1));
			else if (enter) this.enterFile(this.fileIdx);
			else if (matchesKey(data, "a")) this.askApprove();
			else if (matchesKey(data, "m")) this.askMerge();
			else if (matchesKey(data, "u")) this.modal = "update";
			else if (back) this.screen = "list";
		} else {
			const n = this.file?.hunks.length ?? 0;
			if (up) this.moveHunk(-1, n);
			else if (down) this.moveHunk(1, n);
			else if (matchesKey(data, "pageDown") || matchesKey(data, "space")) this.scroll += this.bodyRows - 1;
			else if (matchesKey(data, "pageUp")) this.scroll = Math.max(0, this.scroll - (this.bodyRows - 1));
			else if (matchesKey(data, "n") || matchesKey(data, "]")) this.enterFile(this.fileIdx + 1);
			else if (matchesKey(data, "p") || matchesKey(data, "[")) this.enterFile(this.fileIdx - 1);
			else if (matchesKey(data, "c") || matchesKey(data, "enter")) {
				if (n) {
					this.input.setValue("");
					this.modal = "comment";
					this.status = { text: "", kind: "info" };
				} else this.status = { text: "No hunk to comment on in this file.", kind: "error" };
			} else if (matchesKey(data, "a")) this.askApprove();
			else if (matchesKey(data, "m")) this.askMerge();
			else if (matchesKey(data, "u")) this.modal = "update";
			else if (back) this.screen = "files";
		}
		this.tui.requestRender();
	}

	private moveHunk(d: number, n: number) {
		if (!n) return;
		this.hunkIdx = Math.max(0, Math.min(n - 1, this.hunkIdx + d));
		this.scroll = -1; // sentinel: re-center on selected hunk during render
	}

	private commentInput(data: string) {
		if (matchesKey(data, "escape")) this.modal = "none";
		else if (matchesKey(data, "enter")) {
			const comment = this.input.getValue().trim();
			const hunk = this.file?.hunks[this.hunkIdx];
			if (!comment || !hunk || !this.file || !this.pr) {
				this.status = { text: "Type a comment first (esc cancels).", kind: "error" };
			} else {
				return this.done({
					prompt: buildPrompt({ pr: this.pr.number, repo: this.multi ? this.pr.repo.name : undefined, title: this.pr.title, path: this.file.path, hunk, comment }),
				});
			}
		} else this.input.handleInput(data);
		this.tui.requestRender();
	}

	private userInput(data: string) {
		const users = this.users;
		if (matchesKey(data, "up") || matchesKey(data, "k")) this.userIdx = Math.max(0, this.userIdx - 1);
		else if (matchesKey(data, "down") || matchesKey(data, "j")) this.userIdx = Math.min(users.length - 1, this.userIdx + 1);
		else if (matchesKey(data, "space")) {
			const u = users[this.userIdx];
			if (hiddenUsers.has(u)) hiddenUsers.delete(u);
			else hiddenUsers.add(u);
		} else if (matchesKey(data, "a")) hiddenUsers.clear();
		else if (matchesKey(data, "enter") || matchesKey(data, "escape") || matchesKey(data, "u")) {
			this.modal = "none";
			this.prIdx = Math.min(this.prIdx, Math.max(0, this.prs.length - 1));
			this.status = this.prs.length ? { text: "", kind: "info" } : { text: "No pull requests to show: every user with PRs is hidden or filtered out.", kind: "info" };
		}
		this.tui.requestRender();
	}

	private filterInput(data: string) {
		if (matchesKey(data, "up") || matchesKey(data, "k")) this.menuIdx = Math.max(0, this.menuIdx - 1);
		else if (matchesKey(data, "down") || matchesKey(data, "j")) this.menuIdx = Math.min(FILTERS.length - 1, this.menuIdx + 1);
		else if (matchesKey(data, "enter")) {
			this.filter = FILTERS[this.menuIdx].id;
			this.prIdx = 0;
			this.modal = "none";
			this.status = this.filter !== "all" && !this.me
				? { text: "Could not determine your GitHub user (gh api user failed), so this filter shows nothing.", kind: "error" }
				: this.prs.length ? { text: "", kind: "info" } : { text: "No open pull requests match.", kind: "info" };
		} else if (matchesKey(data, "escape") || matchesKey(data, "v")) this.modal = "none";
		this.tui.requestRender();
	}

	private repoInput(data: string) {
		const n = this.repos.length + 1; // row 0 = all repositories
		if (matchesKey(data, "up") || matchesKey(data, "k")) this.repoIdx = Math.max(0, this.repoIdx - 1);
		else if (matchesKey(data, "down") || matchesKey(data, "j")) this.repoIdx = Math.min(n - 1, this.repoIdx + 1);
		else if (matchesKey(data, "enter")) {
			this.focus = this.repoIdx ? this.repos[this.repoIdx - 1] : undefined;
			this.prIdx = 0;
			this.modal = "none";
			this.status = this.prs.length ? { text: "", kind: "info" } : { text: "No open pull requests.", kind: "info" };
		} else if (matchesKey(data, "escape") || matchesKey(data, "f")) this.modal = "none";
		this.tui.requestRender();
	}

	private updateInput(data: string) {
		if (matchesKey(data, "y") || matchesKey(data, "enter")) {
			this.modal = "none";
			void this.update();
		} else if (matchesKey(data, "n") || matchesKey(data, "escape")) {
			this.modal = "none";
			this.status = { text: "Update cancelled.", kind: "info" };
		}
		this.tui.requestRender();
	}

	private async update() {
		const pr = this.prs[this.prIdx];
		const out = await this.guard(`Updating branch of #${pr.number}…`, () => updateBranch(this.ex(pr), pr.number), true);
		if (out !== undefined) this.status = { text: `Merged ${pr.baseRefName} into ${pr.headRefName}. Try merging again.`, kind: "success" };
	}

	private mergeInput(data: string) {
		const method: MergeMethod | undefined = matchesKey(data, "s") ? "squash" : matchesKey(data, "m") ? "merge" : matchesKey(data, "r") ? "rebase" : undefined;
		if (method) {
			this.modal = "none";
			void this.merge(method);
		} else if (matchesKey(data, "escape") || matchesKey(data, "n")) {
			this.modal = "none";
			this.status = { text: "Merge cancelled.", kind: "info" };
		}
		this.tui.requestRender();
	}

	private confirmInput(data: string) {
		if (matchesKey(data, "y") || matchesKey(data, "enter")) {
			this.modal = "none";
			void this.approve();
		} else if (matchesKey(data, "n") || matchesKey(data, "escape")) {
			this.modal = "none";
			this.status = { text: "Approval cancelled.", kind: "info" };
		}
		this.tui.requestRender();
	}

	// ---------- render ----------
	invalidate(): void {
		this.input.invalidate();
	}

	render(width: number): string[] {
		const t = this.theme;
		const rows = Math.max(8, this.tui.terminal.rows);
		const fit = (s: string) => {
			const c = truncateToWidth(s, width);
			return c + " ".repeat(Math.max(0, width - visibleWidth(c)));
		};

		const fl = this.filter === "all" ? "" : ` · ${FILTERS.find((x) => x.id === this.filter)!.label}`;
		const hid = [...hiddenUsers].filter((u) => this.users.includes(u)).length;
		const crumbs = [(this.multi ? `Open PRs · ${this.focus?.name ?? `all ${this.repos.length} repos`}` : "Open PRs") + fl + (hid ? ` · ${hid} user${hid > 1 ? "s" : ""} hidden` : "")];
		if (this.screen !== "list" && this.pr) crumbs.push(`${this.multi ? this.label(this.pr) : ""}#${this.pr.number} ${this.pr.title}`);
		if (this.screen === "diff" && this.file) crumbs.push(clean(this.file.path));
		const header = [fit(t.bold(t.fg("accent", " pi-merger ")) + t.fg("muted", crumbs.join("  ›  "))), fit(t.fg("borderMuted", "─".repeat(width)))];

		// footer: status line + key bindings (+ modal prompt)
		const footer: string[] = [fit(t.fg("borderMuted", "─".repeat(width)))];
		if (this.modal === "comment") {
			footer.push(...this.input.render(width).map(fit));
			footer.push(fit(t.fg("dim", " enter send to model · esc cancel   (not posted to the PR)")));
		} else if (this.modal === "users") {
			footer.push(fit(""));
			footer.push(fit(t.fg("dim", " ↑/↓ move · space show/hide · a show all · enter/esc done")));
		} else if (this.modal === "repo" || this.modal === "filter") {
			footer.push(fit(""));
			footer.push(fit(t.fg("dim", ` ↑/↓ choose ${this.modal === "repo" ? "repository" : "filter"} · enter select · esc cancel`)));
		} else if (this.modal === "confirm" && this.pr) {
			footer.push(fit(t.fg("warning", ` Approve #${this.pr.number} "${this.pr.title}" on GitHub?`)));
			footer.push(fit(t.fg("dim", " y/enter confirm (runs gh pr review --approve) · n/esc cancel")));
		} else if (this.modal === "update" && this.pr) {
			footer.push(fit(t.fg("warning", ` Merge ${this.pr.baseRefName} into ${this.pr.headRefName} on GitHub (pushes a commit to the PR branch)?`)));
			footer.push(fit(t.fg("dim", " y/enter confirm (runs gh pr update-branch) · n/esc cancel")));
		} else if (this.modal === "merge" && this.pr) {
			footer.push(fit(t.fg("warning", ` Merge #${this.pr.number} "${this.pr.title}" into ${this.pr.baseRefName}? This cannot be undone from here.`)));
			footer.push(fit(t.fg("dim", " s squash · m merge commit · r rebase · esc/n cancel (runs gh pr merge)")));
		} else {
			const s = this.loading
				? t.fg("accent", ` ⏳ ${this.loading}`)
				: this.status.text
					? t.fg(this.status.kind === "error" ? "error" : this.status.kind === "success" ? "success" : "muted", ` ${this.status.text}`)
					: "";
			footer.push(fit(s));
			footer.push(fit(t.fg("dim", " " + this.keyHelp())));
		}

		const bodyRows = Math.max(1, rows - header.length - footer.length);
		this.bodyRows = bodyRows;
		const body = this.renderBody(width, bodyRows).slice(0, bodyRows).map(fit);
		while (body.length < bodyRows) body.push(fit(""));
		return [...header, ...body, ...footer];
	}

	private keyHelp(): string {
		if (this.loading) return this.cancellable ? "esc cancel request" : "request sent to GitHub, waiting for the result…";
		if (this.screen === "list") return `↑/↓ j/k move · enter open · ${this.multi ? "f repo · " : ""}v filter · u users · r refresh · q/esc quit`;
		if (this.screen === "files") return "↑↓ file · enter/→ select hunks · pgup/dn scroll · a approve · m merge · u update · esc back · q quit";
		return "↑↓ hunk · pgup/dn · n/p file · c comment · a approve · m merge · u update · esc back · q quit";
	}

	private row(text: string, selected: boolean, width: number): string {
		const line = truncateToWidth(text, width);
		const padded = line + " ".repeat(Math.max(0, width - visibleWidth(line)));
		return selected ? this.theme.bg("selectedBg", padded) : padded;
	}

	private renderBody(width: number, h: number): string[] {
		const t = this.theme;
		if (this.screen === "list") {
			if (this.modal === "repo") return this.renderRepoMenu(width, h);
			if (this.modal === "filter") return this.renderFilterMenu(width, h);
			if (this.modal === "users") return this.renderUserMenu(width, h);
			if (!this.prs.length) return [];
			return this.renderPRTable(width, h);
		}
		if (!this.files.length) return [];
		// Narrow terminal: no room for two panes. Files screen = list only, diff screen = diff only.
		if (width < SPLIT_MIN_WIDTH) {
			return this.screen === "files" ? this.renderFileList(width, h) : this.renderDiff(width, h);
		}
		const leftW = Math.min(44, Math.max(28, Math.floor(width * 0.3)));
		const rightW = width - leftW - 1;
		const left = this.renderFileList(leftW, h);
		const right = this.renderDiff(rightW, h);
		const sep = t.fg("borderMuted", "│");
		const pad = (l: string, w: number) => l + " ".repeat(Math.max(0, w - visibleWidth(l)));
		return Array.from({ length: h }, (_, i) => pad(left[i] ?? "", leftW) + sep + (right[i] ?? ""));
	}

	private renderUserMenu(width: number, h: number): string[] {
		const t = this.theme;
		const users = this.users;
		const start = Math.max(0, Math.min(this.userIdx - Math.floor((h - 1) / 2), users.length - (h - 1)));
		return [t.fg("muted", " Show pull requests from these users:")].concat(
			users.slice(start, start + h - 1).map((u, k) => {
				const i = start + k;
				const on = !hiddenUsers.has(u);
				const n = this.all.filter((p) => userOf(p) === u).length;
				return this.row(`${i === this.userIdx ? "›" : " "} ${on ? t.fg("success", "[x]") : t.fg("dim", "[ ]")} ${u} ${t.fg("muted", `(${n})`)}`, i === this.userIdx, width);
			}),
		);
	}

	private renderFilterMenu(width: number, h: number): string[] {
		const t = this.theme;
		const inRepo = this.all.filter((p) => !this.focus || p.repo === this.focus);
		return [t.fg("muted", " Show pull requests:")].concat(
			FILTERS.slice(0, h - 1).map((f, i) =>
				this.row(`${i === this.menuIdx ? "›" : " "} ${f.label} ${t.fg("muted", `(${inRepo.filter((p) => this.matches(p, f.id)).length})`)}${f.id === this.filter ? t.fg("accent", " ✓") : ""}`, i === this.menuIdx, width),
			),
		);
	}

	/** PR list as aligned columns: date, repo, owner, #, author, title, branch. Title takes the leftover width. */
	private renderPRTable(width: number, h: number): string[] {
		const t = this.theme;
		const rows = this.prs.map((p) => {
			const [owner, repo] = (repoSlug(p.url) ?? `|${p.repo.name}`).split(/[/|]/);
			return { p, date: fmtDate(p.createdAt), owner, repo, num: `#${p.number}`, author: p.author?.login ?? "?", branch: `${p.headRefName} → ${p.baseRefName}` };
		});
		const w = (f: (r: (typeof rows)[number]) => string, head: string, cap: number) => Math.min(cap, Math.max(head.length, ...rows.map((r) => f(r).length)));
		const cols = [
			{ head: "Created", w: 16, f: (r: (typeof rows)[number]) => r.date, color: "muted" },
			...(this.multi
				? [
						{ head: "Repo", w: w((r) => r.repo, "Repo", 32), f: (r: (typeof rows)[number]) => r.repo, color: "success" },
						{ head: "Owner", w: w((r) => r.owner, "Owner", 18), f: (r: (typeof rows)[number]) => r.owner, color: "muted" },
					]
				: []),
			{ head: "PR", w: w((r) => r.num, "PR", 8), f: (r: (typeof rows)[number]) => r.num, color: "accent" },
			{ head: "Author", w: w((r) => r.author, "Author", 20), f: (r: (typeof rows)[number]) => r.author, color: "muted" },
		];
		const fixed = 2 + cols.reduce((n, c) => n + c.w + 2, 0);
		const branchW = width - fixed >= 110 ? Math.min(34, w((r) => r.branch, "Branch", 34)) : 0; // branch column only on wide terminals
		const titleW = Math.max(10, width - fixed - (branchW ? branchW + 2 : 0));
		const cell = (text: string, cw: number) => truncateToWidth(text, cw, "…", true);

		const headLine = "  " + [...cols.map((c) => cell(c.head, c.w)), cell("Title", titleW), ...(branchW ? [cell("Branch", branchW)] : [])].join("  ");
		const out = [t.bold(t.fg("muted", truncateToWidth(headLine, width)))];
		const bodyH = h - 1;
		const start = Math.max(0, Math.min(this.prIdx - Math.floor(bodyH / 2), rows.length - bodyH));
		rows.slice(start, start + bodyH).forEach((r, k) => {
			const sel = start + k === this.prIdx;
			const marks = (r.p.isDraft ? " [draft]" : "") + (this.isOwn(r.p) ? " (yours)" : "");
			const title = cell(clean(r.p.title), Math.max(1, titleW - marks.length)).trimEnd();
			const marked = title + (r.p.isDraft ? t.fg("warning", " [draft]") : "") + (this.isOwn(r.p) ? t.fg("accent", " (yours)") : "");
			const pad = " ".repeat(Math.max(0, titleW - visibleWidth(title) - marks.length));
			const cells = cols.map((c) => t.fg(c.color as "muted", cell(c.f(r), c.w)));
			const parts = [...cells, marked + pad, ...(branchW ? [t.fg("muted", cell(r.branch, branchW))] : [])];
			out.push(this.row(`${sel ? "›" : " "} ${parts.join("  ")}`, sel, width));
		});
		return out;
	}

	private renderRepoMenu(width: number, h: number): string[] {
		const t = this.theme;
		const slug = (r: Repo) => { const p = this.all.find((x) => x.repo === r); return p ? this.label(p) : r.name; };
		const names = ["All repositories", ...this.repos.map(slug)];
		const count = (i: number) => (i ? this.all.filter((p) => p.repo === this.repos[i - 1]).length : this.all.length);
		const start = Math.max(0, Math.min(this.repoIdx - Math.floor(h / 2), names.length - h));
		return [t.fg("muted", " Focus on repository:")].concat(
			names.slice(start, start + h - 1).map((n, k) => {
				const i = start + k;
				return this.row(`${i === this.repoIdx ? "›" : " "} ${n} ${t.fg("muted", `(${count(i)} open)`)}`, i === this.repoIdx, width);
			}),
		);
	}

	private renderFileList(width: number, h: number): string[] {
		const t = this.theme;
		const start = Math.max(0, Math.min(this.fileIdx - Math.floor(h / 2), this.files.length - h));
		return this.files.slice(start, start + h).map((f, i) => {
			const sel = start + i === this.fileIdx;
			const statPlain = `+${f.added} -${f.removed}`;
			const stat = `${t.fg("success", `+${f.added}`)} ${t.fg("error", `-${f.removed}`)}`;
			// keep the end of the path (the file name) when it does not fit
			const avail = Math.max(4, width - 2 - statPlain.length - 1);
			let path = clean(f.path);
			if (path.length > avail) path = "…" + path.slice(path.length - avail + 1);
			const line = `${sel ? "›" : " "} ${path} ${stat}`;
			// highlight bar only while the file list has focus; in the diff the › marker is enough
			return this.row(line, sel && this.screen === "files", width);
		});
	}

	private renderDiff(width: number, h: number): string[] {
		const t = this.theme;
		const f = this.file;
		if (!f) return [];
		const lines: string[] = [];
		const hunkStart: number[] = [];
		const gutter = 2;
		const w = Math.max(1, width - gutter);
		const color = (l: string) =>
			l[0] === "+" ? t.fg("toolDiffAdded", l) : l[0] === "-" ? t.fg("toolDiffRemoved", l) : t.fg("toolDiffContext", l);
		if (!f.hunks.length) lines.push(t.fg("muted", `  ${f.note ?? "no textual changes"}`));
		f.hunks.forEach((hk, hi) => {
			hunkStart.push(lines.length);
			const sel = this.screen === "diff" && hi === this.hunkIdx;
			const mark = sel ? t.fg("accent", "▌ ") : "  ";
			lines.push(mark + t.bold(t.fg(sel ? "accent" : "mdHeading", truncateToWidth(clean(hk.header), w))));
			for (const l of hk.lines) lines.push(mark + color(truncateToWidth(clean(l), w)));
		});

		const max = Math.max(0, lines.length - h);
		if (this.scroll < 0) {
			// keep the selected hunk header in view, preferring to show the whole hunk
			const s = hunkStart[this.hunkIdx] ?? 0;
			const e = (hunkStart[this.hunkIdx + 1] ?? lines.length) - 1;
			let top = Math.min(this.scrollBase(), max);
			if (s < top) top = s;
			else if (e >= top + h) top = Math.min(s, e - h + 1);
			this.scroll = top;
		}
		this.scroll = Math.min(this.scroll, max);
		this.lastTop = this.scroll;
		return lines.slice(this.scroll, this.scroll + h);
	}

	private lastTop = 0;
	private scrollBase() {
		return this.lastTop;
	}
}

export default function (pi: ExtensionAPI) {
	const open = async (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/merger needs the interactive TUI", "error");
			return;
		}
		const found = findRepos(ctx.cwd);
		// Not a repo and no repos below it: let gh report the problem from cwd, as before.
		const repos = found.length ? found : [{ name: basename(ctx.cwd), dir: ctx.cwd }];
		const execFor = (r: Repo): Exec => (cmd, args) => pi.exec(cmd, args, { cwd: r.dir, timeout: 60_000 });
		const result = await ctx.ui.custom<Result>(
			(tui, theme, _kb, done) => new MergerView(tui, theme, repos, execFor, done),
			{
				overlay: true,
				overlayOptions: { anchor: "top-left", row: 0, col: 0, width: "100%", maxHeight: "100%", margin: 0 },
				blocked: { kind: "question", message: "Reviewing pull requests" },
			},
		);
		if (!result) return;
		// Goes to the model in this session only; nothing is posted to GitHub.
		if (ctx.isIdle()) pi.sendUserMessage(result.prompt);
		else {
			pi.sendUserMessage(result.prompt, { deliverAs: "followUp" });
			ctx.ui.notify("Agent busy: comment queued as follow-up", "info");
		}
	};

	pi.registerCommand("merger", {
		description: "Review open GitHub PRs (gh) in a full-screen TUI; send hunk comments to the model or approve",
		handler: (_args, ctx) => open(ctx),
	});
	pi.registerShortcut("ctrl+shift+m", {
		description: "Open pi-merger (PR review)",
		handler: (ctx) => open(ctx),
	});
}
