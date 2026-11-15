import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
import { approvePR, currentUser, type Exec, GhError, listPRs, type MergeMethod, mergePR, type PR, prDiff, updateBranch } from "./gh.ts";

type Theme = Parameters<Parameters<ExtensionCommandContext["ui"]["custom"]>[0]>[1];
type Result = { prompt: string } | undefined;
type Screen = "list" | "files" | "diff";
type Modal = "none" | "comment" | "confirm" | "merge" | "update";

const clean = (s: string) => s.replace(/\t/g, "    ").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

const SPLIT_MIN_WIDTH = 100;

class MergerView implements Component, Focusable {
	focused = false; // propagated to the comment Input (IME cursor placement)
	private screen: Screen = "list";
	private modal: Modal = "none";
	private prs: PR[] = [];
	private me: string | undefined;
	private files: FileDiff[] = [];
	private prIdx = 0;
	private fileIdx = 0;
	private hunkIdx = 0;
	private scroll = 0; // diff body scroll offset
	private loading = "";
	private status: { text: string; kind: "error" | "success" | "info" } = { text: "", kind: "info" };
	private gen = 0; // invalidates stale async results
	private input = new Input({ prompt: "comment> " });
	private bodyRows = 10;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private exec: Exec,
		private done: (r: Result) => void,
	) {
		void this.loadPRs();
	}

	// ---------- data ----------
	private async guard<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
		const g = ++this.gen;
		this.loading = label;
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
		const res = await this.guard("Loading open pull requests…", async () => {
			const prs = await listPRs(this.exec);
			return { prs, me: await currentUser(this.exec) };
		});
		if (!res) return;
		const { prs } = res;
		this.me = res.me;
		this.prs = prs;
		this.prIdx = Math.min(this.prIdx, Math.max(0, prs.length - 1));
		if (!prs.length) this.status = { text: "No open pull requests.", kind: "info" };
	}

	private async openPR() {
		const pr = this.prs[this.prIdx];
		if (!pr) return;
		const text = await this.guard(`Loading diff of #${pr.number}…`, () => prDiff(this.exec, pr.number));
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
		const out = await this.guard(`Merging #${pr.number} (${method})…`, () => mergePR(this.exec, pr.number, method));
		if (out === undefined) return;
		// merged PR is no longer open: drop it and go back to the list
		this.prs.splice(this.prIdx, 1);
		this.prIdx = Math.min(this.prIdx, Math.max(0, this.prs.length - 1));
		this.files = [];
		this.screen = "list";
		this.status = { text: `Merged #${pr.number} (${method}).`, kind: "success" };
	}

	private async approve() {
		const pr = this.prs[this.prIdx];
		const out = await this.guard(`Approving #${pr.number}…`, () => approvePR(this.exec, pr.number));
		if (out !== undefined) this.status = { text: `Approved #${pr.number}.`, kind: "success" };
	}

	// ---------- state helpers ----------
	private get pr(): PR | undefined {
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
		if (this.loading) {
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
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
					prompt: buildPrompt({ pr: this.pr.number, title: this.pr.title, path: this.file.path, hunk, comment }),
				});
			}
		} else this.input.handleInput(data);
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
		const out = await this.guard(`Updating branch of #${pr.number}…`, () => updateBranch(this.exec, pr.number));
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

		const crumbs = ["Open PRs"];
		if (this.screen !== "list" && this.pr) crumbs.push(`#${this.pr.number} ${this.pr.title}`);
		if (this.screen === "diff" && this.file) crumbs.push(this.file.path);
		const header = [fit(t.bold(t.fg("accent", " pi-merger ")) + t.fg("muted", crumbs.join("  ›  "))), fit(t.fg("borderMuted", "─".repeat(width)))];

		// footer: status line + key bindings (+ modal prompt)
		const footer: string[] = [fit(t.fg("borderMuted", "─".repeat(width)))];
		if (this.modal === "comment") {
			footer.push(...this.input.render(width).map(fit));
			footer.push(fit(t.fg("dim", " enter send to model · esc cancel   (not posted to the PR)")));
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
		if (this.loading) return "esc cancel request · ctrl+c cancel";
		if (this.screen === "list") return "↑/↓ j/k move · enter open · r refresh · q/esc quit";
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
			if (!this.prs.length) return [];
			const start = Math.max(0, Math.min(this.prIdx - Math.floor(h / 2), this.prs.length - h));
			return this.prs.slice(start, start + h).map((p, i) => {
				const sel = start + i === this.prIdx;
				const draft = (p.isDraft ? t.fg("warning", " [draft]") : "") + (this.isOwn(p) ? t.fg("accent", " (yours)") : "");
				const line = `${sel ? "›" : " "} ${t.fg("accent", `#${p.number}`)} ${clean(p.title)}${draft} ${t.fg("muted", `${p.author?.login ?? "?"} · ${p.headRefName} → ${p.baseRefName}`)}`;
				return this.row(line, sel, width);
			});
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
		const exec: Exec = (cmd, args) => pi.exec(cmd, args, { cwd: ctx.cwd, timeout: 60_000 });
		const result = await ctx.ui.custom<Result>(
			(tui, theme, _kb, done) => new MergerView(tui, theme, exec, done),
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
