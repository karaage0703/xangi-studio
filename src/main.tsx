import { useDraftAutosave } from "./useDraftAutosave";
import { DraftStatusBar } from "./DraftStatusBar";
import { PullRequestDescription } from "./PullRequestDescription";
import { PullRequestView } from "./PullRequestView";
import { workspacePath } from "./api";
import { ArtifactLayout } from "./ArtifactLayout";
import { StudioSettings } from "./StudioSettings";
import { ArtifactRequestsPanel } from "./ArtifactRequestsPanel";
import { initializeHistory } from "./appHistory";

initializeHistory();
import { documentOverviews } from "../shared/document-overview.mjs";
import { ReviewFileTree } from "./ReviewFileTree";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";
import { HtmlPreview } from "./HtmlPreview";
import remarkGfm from "remark-gfm";
import { diffLines } from "diff";
import { pullRequestLabel, githubGroupKey } from "../shared/pr-label.mjs";
import {
  ArrowLeft,
  ArrowRight,
  AlertTriangle,
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileText,
  Files,
  GitCompareArrows,
  History,
  ExternalLink,
  Link2,
  LoaderCircle,
  MessageCircle,
  PencilLine,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings2,
  Users,
  X,
} from "lucide-react";
import { DocumentPage } from "./DocumentPage";
import { CodePane } from "./CodePane";
import { ExplanationDiff, explanationDiffRows } from "./ExplanationDiff";
import {
  accessKey,
  request,
  reviewApi,
  type Mode,
  type Platform,
  type Review,
  type ReviewJob,
  type ReviewPreferences,
  type ReviewSummary,
  type XangiProject,
  xangiApi,
} from "./api";
import { reviewUrl, formatLink } from "../shared/links.mjs";
import {
  buildAutoReviewPrompt,
  buildFileReviewPrompt,
  buildOverviewPrompt,
} from "../shared/auto-review.mjs";
import {
  partitionReviewFiles,
  launchReviewWork,
  reviewJobKey,
} from "../shared/review-plan.mjs";
import { sourcePath } from "../shared/software-overview.mjs";
import "./styles.css";

const platformName: Record<Platform, string> = {
  discord: "Discord",
  slack: "Slack",
  web: "Web",
};
const fileName = (file: string) => file.split("/").at(-1) ?? file;
const dateLabel = (value: string) =>
  new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
const modeFromUrl = (): Mode => {
  const mode = new URLSearchParams(location.search).get("mode");
  return mode === "preview" || mode === "edit" ? mode : "diff";
};
const idFromUrl = () =>
  new URLSearchParams(location.search).get("review") ??
  /^\/review\/([a-zA-Z0-9-]+)$/.exec(location.pathname)?.[1];
const prFromUrl = () => new URLSearchParams(location.search).get("pr");
const cleanText = (value: string) => value.replaceAll("\r\n", "\n");
const inExtension = () => location.pathname.startsWith("/api/extensions/");
const reviewSourceLabel = (review: ReviewSummary) =>
  review.document
    ? (review.document.format ?? "PDF")
    : ["github-pr", "github-repository"].includes(review.changeSet?.kind ?? "")
      ? "GitHub"
      : platformName[review.source];
const changeSetKey = (item: ReviewSummary) => githubGroupKey(item.changeSet);

type ReviewGroup = {
  key: string;
  label: string;
  title: string;
  source: string;
  items: ReviewSummary[];
};

type ConversationResult = {
  reviewer: XangiProject | { id: "xangi-default"; name: string };
  projectId?: string;
  sessionId?: string;
  error?: string;
};

const xangiDefaultReviewer = {
  id: "xangi-default" as const,
  name: "xangiのデフォルト",
};

function App() {
  const [reviewInstruction, setReviewInstruction] = useState("");
  const [reReviewOpen, setReReviewOpen] = useState(false);
  const [reviewTarget, setReviewTarget] = useState<{
    url: string;
    revision?: string;
    file?: string;
    title: string;
    purpose?: "review" | "overview";
  } | null>(null);
  const [selectedReviewerIds, setSelectedReviewerIds] = useState<string[]>([]);
  const [googleUrl, setGoogleUrl] = useState("");
  const [pdfImporting, setPdfImporting] = useState(false);
  const [notionConfigured, setNotionConfigured] = useState(false);
  const [notionSaving, setNotionSaving] = useState(false);
  const [notionUrl, setNotionUrl] = useState("");
  const [notionResultId, setNotionResultId] = useState("");
  useEffect(() => {
    void reviewApi
      .notionConfig()
      .then((c) => setNotionConfigured(c.configured))
      .catch(() => {});
  }, []);
  const [items, setItems] = useState<ReviewSummary[]>([]);
  const [review, setReview] = useState<Review | null>(null);
  const [selectedPr, setSelectedPr] = useState<string | null>(prFromUrl);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<Mode>(modeFromUrl);
  const [mobile, setMobile] = useState(
    matchMedia("(max-width: 800px)").matches,
  );
  const [showExplanations, setShowExplanations] = useState(true);
  const [showFiles, setShowFiles] = useState(!idFromUrl() && !prFromUrl());
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [importingTarget, setImportingTarget] = useState<{
    url: string;
    fromForm: boolean;
  } | null>(null);
  const importing = importingTarget !== null;
  const [launchingTarget, setReviewingTarget] = useState<string | null>(null);
  const [launchingOverview, setOverviewingTarget] = useState<string | null>(
    null,
  );
  const [reviewSessionId, setReviewSessionId] = useState<string | null>(null);
  const [reviewJobs, setReviewJobs] = useState<ReviewJob[]>([]);
  const [jobError, setJobError] = useState("");
  const reviewingTarget =
    launchingTarget ??
    reviewJobs.find(
      (job) => job.status === "running" && job.purpose !== "overview",
    )?.changeSet.url ??
    null;
  const overviewingTarget =
    launchingOverview ??
    reviewJobs.find(
      (job) => job.status === "running" && job.purpose === "overview",
    )?.changeSet.url ??
    null;
  const currentJobs = Array.from(
    new Map(
      [...reviewJobs]
        .filter(
          (job) =>
            job.changeSet.id === review?.changeSet?.id &&
            job.changeSet.kind === review?.changeSet?.kind &&
            job.changeSet.source === review?.changeSet?.source &&
            job.changeSet.url === review?.changeSet?.url &&
            job.changeSet.revision === review?.changeSet?.revision &&
            job.changeSet.editRevision === review?.changeSet?.editRevision &&
            (!job.file || job.file === review?.file) &&
            (!job.files || job.files.includes(review?.file ?? "")) &&
            (job.purpose === "overview" ||
              (job.changeSet.reviewContext ?? "") ===
                (review?.changeSet?.reviewContext ?? "")),
        )
        .map((job) => [reviewJobKey(job), job]),
    ).values(),
  );
  const currentJob =
    currentJobs.find((job) => job.status === "running") ?? currentJobs.at(-1);
  const collectedJobs = useRef(new Set<string>());
  useEffect(() => {
    if (!inExtension()) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (document.hidden) return;
        const jobs = await reviewApi.jobs();
        if (!cancelled) {
          setReviewJobs(jobs);
          setJobError("");
        }
      } catch (cause) {
        if (!cancelled)
          setJobError(
            `レビュー状態を取得できません: ${(cause as Error).message}`,
          );
      } finally {
        if (!cancelled) timer = setTimeout(poll, 2000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    const relevantJobs = selectedPr
      ? reviewJobs.filter(
          (job) =>
            githubGroupKey(job.changeSet) === selectedPr &&
            items.some(
              (item) =>
                changeSetKey(item) === selectedPr &&
                item.changeSet?.revision === job.changeSet.revision &&
                item.changeSet?.editRevision === job.changeSet.editRevision,
            ),
        )
      : currentJobs;
    if (
      !relevantJobs.some(
        (job) =>
          job.status === "completed" &&
          !collectedJobs.current.has(job.sessionId),
      )
    )
      return;
    let cancelled = false;
    void Promise.all([
      reviewApi.list(),
      review ? reviewApi.read(review.id) : Promise.resolve(null),
    ])
      .then(([list, next]) => {
        if (cancelled) return;
        setItems(list);
        setNotionUrl("");
        if (next) setReview(next);
        relevantJobs
          .filter((job) => job.status === "completed")
          .forEach((job) => collectedJobs.current.add(job.sessionId));
      })
      .catch((cause) => {
        if (!cancelled) setJobError((cause as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [reviewJobs, review?.id, selectedPr, items]);

  const [pullRequestUrl, setPullRequestUrl] = useState("");
  const [importFile, setImportFile] = useState<File | undefined>();
  const importFileInput = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [modal, setModal] = useState<
    | "share"
    | "history"
    | "discard"
    | "settings"
    | "conversations"
    | "import"
    | null
  >(new URLSearchParams(location.search).has("import") ? "import" : null);
  const [platform, setPlatform] = useState<Platform>("web");
  const [copied, setCopied] = useState(false);
  const [editorReset, setEditorReset] = useState(0);
  const [selectedExplanation, setSelectedExplanation] = useState(0);
  const [showFullDiff, setShowFullDiff] = useState(false);
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<ReviewPreferences | null>(
    null,
  );
  const [projects, setProjects] = useState<XangiProject[]>([]);
  const [defaultProjectId, setDefaultProjectId] = useState("");
  const [reviewerProjectIds, setReviewerProjectIds] = useState<string[]>([]);
  const [settingsError, setSettingsError] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);
  const [consulting, setConsulting] = useState(false);
  const [conversationResults, setConversationResults] = useState<
    ConversationResult[]
  >([]);
  const pendingAction = useRef<(() => void) | null>(null);
  const textArea = useRef<HTMLTextAreaElement>(null);
  const autosave = useDraftAutosave({
    scope: "review",
    id: review && !review.readOnly ? review.id : null,
    initialContent: cleanText(review?.content ?? ""),
    onRestore: setDraft,
  });
  const dirty = review !== null && draft !== cleanText(review.content);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const requestNumber = useRef(0);

  const navigate = useCallback(
    (id: string, nextMode: Mode, replace = false) => {
      const url = inExtension()
        ? `${workspacePath}?review=${encodeURIComponent(id)}&mode=${nextMode}`
        : reviewUrl(location.origin, id, accessKey, nextMode);
      if (replace) history.replaceState({}, "", url);
      else history.pushState({}, "", url);
    },
    [],
  );

  const openReview = useCallback(
    async (id: string, nextMode: Mode = "diff", replace = false) => {
      const number = ++requestNumber.current;
      setLoading(true);
      setError("");
      setNotice("");
      try {
        const next = await reviewApi.read(id);
        if (number !== requestNumber.current) return;
        const resolvedMode =
          next.document ||
          (next.changeSet?.kind === "github-repository" && nextMode !== "edit")
            ? "preview"
            : next.readOnly && nextMode === "edit"
              ? "diff"
              : nextMode;
        setReview(next);
        setSelectedPr(null);
        setExpandedGroup(changeSetKey(next));
        setDraft(cleanText(next.content));
        setMode(resolvedMode);
        setSelectedExplanation(0);
        setShowFullDiff(false);
        setShowExplanations(true);
        // Open the local repository tree on entry, then show the selected file.
        setShowFiles(replace && next.changeSet?.kind === "workspace");
        setEditorReset((v) => v + 1);
        navigate(id, resolvedMode, replace);
      } catch (err) {
        if (number === requestNumber.current) setError((err as Error).message);
      } finally {
        if (number === requestNumber.current) setLoading(false);
      }
    },
    [navigate],
  );

  const guard = (action: () => void) => {
    if (saving) {
      setNotice("保存が終わるまでお待ちください。");
      return;
    }
    if (dirty) {
      void autosave
        .flush()
        .then(action)
        .catch((e) => setError(e.message));
    } else action();
  };

  const openPullRequest = (key: string, replace = false) => {
    ++requestNumber.current;
    setSelectedPr(key);
    setReview(null);
    setLoading(false);
    setExpandedGroup(key);
    setShowFiles(false);
    const url = `${workspacePath}?pr=${encodeURIComponent(key)}`;
    if (replace) history.replaceState({}, "", url);
    else history.pushState({}, "", url);
  };

  useEffect(() => {
    let disposed = false;
    reviewApi
      .list()
      .then((list) => {
        if (disposed) return;
        setItems(list);
        const prTarget = prFromUrl();
        if (prTarget) {
          setSelectedPr(prTarget);
          setExpandedGroup(prTarget);
          setLoading(false);
          return;
        }
        const target = new URLSearchParams(location.search).has("import")
          ? undefined
          : (idFromUrl() ??
            list.find((r) => r.id === "demo-markdown")?.id ??
            list[0]?.id);
        if (target) void openReview(target, modeFromUrl(), true);
        else setLoading(false);
      })
      .catch((err: Error) => {
        if (!disposed) {
          setError(err.message);
          setLoading(false);
          setShowFiles(false);
        }
      });
    return () => {
      disposed = true;
    };
  }, [openReview]);

  useEffect(() => {
    let disposed = false;
    Promise.all([reviewApi.preferences(), xangiApi.projects()])
      .then(([nextPreferences, nextProjects]) => {
        if (disposed) return;
        const sorted = [...nextProjects].sort((a, b) =>
          a.name.localeCompare(b.name, "ja"),
        );
        setPreferences(nextPreferences);
        setProjects(sorted);
        setDefaultProjectId(nextPreferences.defaultProjectId ?? "");
        setReviewerProjectIds(nextPreferences.reviewerProjectIds);
        setSettingsError("");
      })
      .catch((cause: Error) => {
        if (!disposed) setSettingsError(cause.message);
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    const query = matchMedia("(max-width: 800px)");
    const changed = () => {
      setMobile(query.matches);
    };
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);

  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => {
      if ((dirtyRef.current && autosave.pending) || saving) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const back = () => {
      const target = idFromUrl();
      const prTarget = prFromUrl();
      if (saving) {
        if (review) navigate(review.id, mode, true);
        setNotice("保存が終わるまでお待ちください。");
        return;
      }
      if (dirtyRef.current && autosave.pending) {
        void autosave.flush().catch(() => {});
        if (review) navigate(review.id, mode, true);
        setNotice(
          "編集内容を残しました。下書きの保存完了後に移動してください。",
        );
      } else if (target) void openReview(target, modeFromUrl(), true);
      else if (prTarget) openPullRequest(prTarget, true);
      else {
        setSelectedPr(null);
        setReview(null);
        setShowFiles(true);
      }
    };
    addEventListener("beforeunload", leave);
    addEventListener("popstate", back);
    return () => {
      removeEventListener("beforeunload", leave);
      removeEventListener("popstate", back);
    };
  }, [review, mode, openReview, navigate, autosave.pending, saving]);

  const save = useCallback(async () => {
    if (!review || !dirty || saving || loading || !autosave.ready) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const next = await reviewApi.save(review.id, draft);
      autosave.applied(cleanText(next.content));
      setReview(next);
      setDraft((current) =>
        current === draft ? cleanText(next.content) : current,
      );
      setNotice("保存しました");
      setItems((current) => current.map((r) => (r.id === next.id ? next : r)));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [review, draft, dirty, saving, loading, autosave.ready]);

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void autosave.flush().catch(() => {});
      }
      if (event.key === "Escape") setModal(null);
    };
    addEventListener("keydown", keys);
    return () => removeEventListener("keydown", keys);
  }, [save]);

  const switchMode = (next: Mode) => {
    setMode(next);
    if (review) navigate(review.id, next, true);
  };
  const changes = review ? diffLines(cleanText(review.before), draft) : [];
  const additions = changes
    .filter((c) => c.added)
    .reduce((n, c) => n + c.count, 0);
  const deletions = changes
    .filter((c) => c.removed)
    .reduce((n, c) => n + c.count, 0);
  const currentUrl = review
    ? inExtension()
      ? `${location.origin}${workspacePath}?review=${encodeURIComponent(review.id)}&mode=${mode}`
      : reviewUrl(location.origin, review.id, accessKey, mode)
    : "";
  const shareText = formatLink(
    currentUrl,
    review
      ? `${fileName(review.file)}を${mode === "diff" ? "比較" : "開く"}`
      : "",
    platform,
  );
  const explanations = review?.explanations ?? [];
  const activeExplanation =
    explanations[Math.min(selectedExplanation, explanations.length - 1)];
  const warningCount = explanations.filter(
    (item) => item.severity === "warning" || item.severity === "danger",
  ).length;
  const configuredDefaultProjectId = preferences?.defaultProjectId ?? "";
  const configuredReviewerProjectIds = preferences?.reviewerProjectIds ?? [];
  const reviewGroups = useMemo(() => {
    const groups = new Map<string, ReviewGroup>();
    for (const item of items) {
      if (
        selectedPr
          ? changeSetKey(item) !== selectedPr
          : review
            ? review.changeSet
              ? changeSetKey(item) !== changeSetKey(review)
              : item.id !== review.id
            : false
      )
        continue;
      const key = changeSetKey(item);
      const existing = groups.get(key);
      if (existing) {
        existing.items.push(item);
        continue;
      }
      groups.set(key, {
        key,
        label: ["github-pr", "github-repository"].includes(
          item.changeSet?.kind ?? "",
        )
          ? pullRequestLabel(item.changeSet)!
          : item.changeSet
            ? item.changeSet.title || item.document?.name || "資料レビュー"
            : "単体ファイル",
        title: item.changeSet?.title ?? "個別に開いたファイル",
        source: item.changeSet?.source ?? reviewSourceLabel(item),
        items: [item],
      });
    }

    const query = search.trim().toLowerCase();
    return [...groups.values()]
      .map((group) => {
        if (!query) return group;
        const groupMatches = `${group.label} ${group.title} ${group.source}`
          .toLowerCase()
          .includes(query);
        return {
          ...group,
          items: groupMatches
            ? group.items
            : group.items.filter((item) =>
                `${item.file} ${item.title}`.toLowerCase().includes(query),
              ),
        };
      })
      .filter((group) => group.items.length > 0);
  }, [items, search, selectedPr, review]);
  const selectedPrItems = useMemo(
    () =>
      items.filter((item) => selectedPr && changeSetKey(item) === selectedPr),
    [items, selectedPr],
  );
  const changeSetCount = new Set(items.map(changeSetKey)).size;

  async function copy() {
    try {
      if (navigator.clipboard?.writeText)
        await navigator.clipboard.writeText(shareText);
      else {
        textArea.current?.focus();
        textArea.current?.select();
        if (!document.execCommand("copy")) throw new Error("manual");
      }
      setCopied(true);
    } catch {
      textArea.current?.focus();
      textArea.current?.select();
      setNotice("リンクを選択しました。コピーして使ってください。");
    }
  }

  async function checkPullRequest(url: string, clearInput = false) {
    if (!url.trim() || importing || reviewingTarget) return;
    const startedAtUrl = location.href;
    setImportingTarget({ url: url.trim(), fromForm: clearInput });
    if (clearInput) setModal(null);
    setError("");
    setNotice("");
    setReviewSessionId(null);
    try {
      const result = await reviewApi.importGithub(url.trim());
      const list = await reviewApi.list();
      setItems(list);
      if (clearInput) {
        setPullRequestUrl("");
      }
      const importedPr =
        list.find((item) => item.id === result.imported[0]?.id) ??
        list.find((item) => item.changeSet?.url === url.trim());
      if (
        location.href === startedAtUrl &&
        ["github-pr", "github-repository"].includes(
          importedPr?.changeSet?.kind ?? "",
        )
      )
        openPullRequest(changeSetKey(importedPr!));
      setNotice(
        result.status === "unchanged"
          ? "取り込み元に更新はありません。必要に応じてレビュー・編集を選んでください。"
          : `${result.imported.length}ファイルを取り込みました${
              result.skipped.length
                ? `（${result.skipped.length}件スキップ: ${result.skipped
                    .slice(0, 5)
                    .map((item) => `${item.file}: ${item.reason}`)
                    .join(
                      " / ",
                    )}${result.skipped.length > 5 ? " / ほか" : ""}）`
                : ""
            }。レビュー・編集を選べます。まだAIは実行していません。`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setImportingTarget(null);
    }
  }

  function openReviewStart(target: {
    url: string;
    revision?: string;
    file?: string;
    title: string;
    purpose?: "review" | "overview";
  }) {
    setReviewTarget(target);
    setReviewInstruction("");
    setSelectedReviewerIds([
      ...new Set([
        preferences?.defaultProjectId ?? "xangi-default",
        ...(target.purpose === "overview"
          ? []
          : (preferences?.reviewerProjectIds ?? [])),
      ]),
    ]);
    setReReviewOpen(true);
  }

  async function reviewImportedPullRequest(
    url: string,
    list: ReviewSummary[],
    file?: string,
    reviewerIds?: string[],
    instruction?: string,
    purpose: "review" | "overview" = "review",
  ) {
    const files = list.filter(
      (item) => item.changeSet?.url === url && (!file || item.file === file),
    );
    const changeSet = files[0]?.changeSet;
    if (!changeSet?.revision || !files.length) {
      setError("レビュー対象の版が見つかりません。更新を確認してください。");
      return;
    }
    const setBusy =
      purpose === "overview" ? setOverviewingTarget : setReviewingTarget;
    setBusy(url);
    setReviewSessionId(null);
    try {
      const settings = await reviewApi.preferences();
      const available = await xangiApi.projects();
      const ids = [
        ...new Set(
          reviewerIds ?? [
            settings.defaultProjectId ?? "xangi-default",
            ...settings.reviewerProjectIds,
          ],
        ),
      ];
      const reviewers = (purpose === "overview" ? ids.slice(0, 1) : ids).map(
        (id) => {
          if (id === "xangi-default") return xangiDefaultReviewer;
          const project = available.find((p) => p.id === id);
          if (!project)
            throw new Error(
              `設定したレビュワー ${id} が見つかりません。設定を確認してください。`,
            );
          return { id: project.id, name: project.name };
        },
      );
      const groups: ReviewSummary[][] =
        purpose === "overview" || files[0].document || file
          ? [files]
          : partitionReviewFiles(files);
      const documentPrompt = files[0].document
        ? (await reviewApi.documentPrompt(files[0].id)).prompt
        : null;
      const work = reviewers.flatMap((reviewer) =>
        groups.map((groupFiles, index) => ({
          reviewer,
          scope: groupFiles.map((item) => item.file),
          group: { index: index + 1, total: groups.length },
          prompt:
            purpose === "overview"
              ? buildOverviewPrompt(
                  url,
                  groupFiles.map((item) => sourcePath(item.file)),
                  changeSet,
                )
              : (documentPrompt ??
                (file
                  ? buildFileReviewPrompt(
                      url,
                      sourcePath(file),
                      instruction,
                      changeSet,
                    )
                  : buildAutoReviewPrompt(
                      url,
                      groupFiles.map((item) => sourcePath(item.file)),
                      changeSet.reviewContext,
                      changeSet,
                    ))),
        })),
      );
      const results = await launchReviewWork(work, {
        createSession: (item: (typeof work)[number]) =>
          xangiApi.createSession(
            item.reviewer.id === "xangi-default" ? undefined : item.reviewer.id,
          ),
        register: (sessionId: string, item: (typeof work)[number]) =>
          reviewApi.registerJob(changeSet, sessionId, item.reviewer, file, {
            purpose,
            ...(purpose === "review" && !files[0].document
              ? { files: item.scope, group: item.group }
              : {}),
          }),
        onJob: (job: ReviewJob) => {
          setReviewJobs((previous) => [
            ...previous.filter((item) => item.sessionId !== job.sessionId),
            job,
          ]);
          setReviewSessionId(job.sessionId);
        },
        send: (sessionId: string, item: (typeof work)[number]) =>
          xangiApi.sendMessage(sessionId, item.prompt),
        onSendError: (cause: Error, item: (typeof work)[number]) =>
          setError(
            `${item.reviewer.name}への送信に失敗しました: ${cause.message}`,
          ),
      });
      const failures = results.flatMap((result, index) =>
        result.status === "rejected"
          ? [
              `${work[index].reviewer.name} ${work[index].group.index}/${work[index].group.total}: ${String(result.reason?.message ?? result.reason)}`,
            ]
          : [],
      );
      if (failures.length)
        setError(`一部の処理を開始できませんでした: ${failures.join(" / ")}`);
      setNotice("");
    } catch (cause) {
      setError(
        `AI${purpose === "overview" ? "概要の作成" : "レビュー"}を開始できませんでした: ${(cause as Error).message}`,
      );
    } finally {
      setBusy(null);
    }
  }

  async function reviewCurrentPullRequest(
    url: string,
    revision?: string,
    file?: string,
    purpose: "review" | "overview" = "review",
  ) {
    if (
      importing ||
      (purpose === "overview" ? overviewingTarget : reviewingTarget)
    )
      return;
    const setBusy =
      purpose === "overview" ? setOverviewingTarget : setReviewingTarget;
    setError("");
    setNotice(
      purpose === "overview"
        ? "概要の作成を開始します。"
        : "AIレビューを開始します。",
    );
    setBusy(url);
    try {
      const selected = items.find(
        (item) =>
          item.changeSet?.url === url &&
          item.changeSet.revision === revision &&
          (!file || item.file === file),
      );
      if (!selected)
        throw new Error(
          "レビュー対象の版が見つかりません。更新を確認してください。",
        );
      if (!file && purpose === "review")
        await request(
          `/api/reviews/${encodeURIComponent(selected.id)}/context`,
          {
            method: "PUT",
            body: JSON.stringify({
              reviewContext: reviewInstruction,
              revision,
            }),
          },
        );
      const list = await reviewApi.list();
      setItems(list);
      if (review?.id === selected.id)
        setReview(await reviewApi.read(selected.id));
      await reviewImportedPullRequest(
        url,
        list.filter(
          (item) =>
            item.changeSet?.revision === revision &&
            item.changeSet?.url === url,
        ),
        file,
        selectedReviewerIds,
        reviewInstruction,
        purpose,
      );
    } catch (cause) {
      setError((cause as Error).message);
      setNotice("");
    } finally {
      setBusy(null);
    }
  }

  async function importPdf(file?: File, google?: string) {
    if ((!file && !google) || pdfImporting) return;
    const startedAtUrl = location.href;
    setPdfImporting(true);
    setModal(null);
    setError("");
    setNotice("資料を取得し、ページごとに変換しています。");
    try {
      const result = google
        ? await reviewApi.importGoogle(google)
        : await reviewApi.importPdf(file!);
      const list = await reviewApi.list();
      setItems(list);
      if (result.imported[0] && location.href === startedAtUrl)
        await openReview(result.imported[0].id, "preview");
      setNotice(
        `${result.imported.length}ページを取り込みました。レビュー・編集を選べます。まだAIは実行していません。`,
      );
      if (google) {
        setGoogleUrl("");
      } else {
        setImportFile(undefined);
        if (importFileInput.current) importFileInput.current.value = "";
      }
    } catch (cause) {
      setError((cause as Error).message);
      setNotice("");
    } finally {
      setPdfImporting(false);
    }
  }
  const notionExport = (id: string, label: string, compact = false) => (
    <div className="notion-export">
      <button
        className="quiet-button"
        disabled={
          !notionConfigured ||
          notionSaving ||
          reviewJobs.some((job) => {
            const target = items.find((item) => item.id === id)?.changeSet;
            return (
              target &&
              job.status === "running" &&
              job.changeSet.kind === target.kind &&
              job.changeSet.id === target.id &&
              job.changeSet.source === target.source &&
              job.changeSet.revision === target.revision &&
              job.changeSet.editRevision === target.editRevision
            );
          })
        }
        onClick={() => void saveNotion(id)}
      >
        {notionSaving ? "Notionへ保存中…" : label}
      </button>
      {(!compact || !notionConfigured) && (
        <details className="notion-help">
          <summary>保存について</summary>
          {!compact && (
            <small>同じ版の取り込み済みファイル全体を保存します。</small>
          )}
          {!notionConfigured && (
            <small>
              Notion保存は任意です。共通メニューの「設定」で保存先を指定してください。
            </small>
          )}
        </details>
      )}
      {notionUrl && notionResultId === id && (
        <a href={notionUrl} target="_blank" rel="noreferrer">
          保存したNotionページを開く
        </a>
      )}
    </div>
  );
  async function saveNotion(id: string) {
    if (notionSaving) return;
    setNotionSaving(true);
    setNotionUrl("");
    setError("");
    try {
      const result = await reviewApi.exportNotion(id);
      setNotionResultId(id);
      setNotionUrl(result.url);
      setNotice("レビュー結果をNotionへ保存しました。");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setNotionSaving(false);
    }
  }

  async function importPullRequest(event: React.FormEvent) {
    event.preventDefault();
    await checkPullRequest(pullRequestUrl, true);
  }

  async function saveReviewSettings(event: React.FormEvent) {
    event.preventDefault();
    if (savingSettings) return;
    setSavingSettings(true);
    setSettingsError("");
    try {
      const next = await reviewApi.savePreferences(
        defaultProjectId || null,
        reviewerProjectIds,
      );
      setPreferences(next);
      setReviewerProjectIds(next.reviewerProjectIds);
      setNotice("レビュー設定を保存しました");
      setModal(null);
    } catch (cause) {
      setSettingsError((cause as Error).message);
    } finally {
      setSavingSettings(false);
    }
  }

  function openSettings(message = "") {
    setDefaultProjectId(preferences?.defaultProjectId ?? "");
    setReviewerProjectIds(preferences?.reviewerProjectIds ?? []);
    if (message || preferences) setSettingsError(message);
    setModal("settings");
  }

  async function setArchived(key: string, archived: boolean) {
    setError("");
    try {
      const nextPreferences = await reviewApi.setArchived(
        key.startsWith("github-repository:")
          ? key.replace(/@[a-f0-9]{40,64}$/, "")
          : key,
        archived,
      );
      const list = await reviewApi.list();
      setPreferences(nextPreferences);
      setItems(list);
      if (archived && review && changeSetKey(review) === key) {
        if (list[0]) await openReview(list[0].id, "diff", true);
        else {
          setReview(null);
          setShowFiles(true);
        }
      }
      setNotice(archived ? "一覧から外しました" : "一覧へ戻しました");
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  function reviewPrompt(multiAgent: boolean): string {
    if (!review || !activeExplanation) return "";
    const rows = explanationDiffRows({
      before: cleanText(review.before),
      after: draft,
      explanation: activeExplanation,
    });
    const focusedDiff = rows
      .map((row) => {
        const marker =
          row.kind === "added" ? "+" : row.kind === "removed" ? "-" : " ";
        const oldLine = String(row.oldLine ?? "").padStart(4, " ");
        const newLine = String(row.newLine ?? "").padStart(4, " ");
        return `${marker} ${oldLine} ${newLine} ${row.text}`;
      })
      .join("\n");
    return [
      multiAgent
        ? "次の変更箇所を、他のレビュー結果に引きずられず独立してコードレビューしてください。問題がなければ、その理由も明記してください。"
        : "次の変更箇所について相談したいです。意図と影響を踏まえて、気になる点や確認すべき点を一緒に整理してください。",
      `PR: ${review.changeSet?.title ?? review.title}`,
      review.changeSet?.url ? `URL: ${review.changeSet.url}` : "",
      `ファイル: ${review.file}`,
      `注目箇所: ${activeExplanation.heading}`,
      activeExplanation.summary,
      activeExplanation.impact ? `影響: ${activeExplanation.impact}` : "",
      activeExplanation.review ? `レビュー: ${activeExplanation.review}` : "",
      focusedDiff ? `対応する差分:\n\`\`\`diff\n${focusedDiff}\n\`\`\`` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  async function startConversations(multiAgent: boolean) {
    if (!review || !activeExplanation || consulting) return;
    const configuredProject = projects.find(
      (candidate) => candidate.id === configuredDefaultProjectId,
    );
    const selectedReviewers: ConversationResult[] = [
      configuredProject
        ? { reviewer: configuredProject, projectId: configuredProject.id }
        : { reviewer: xangiDefaultReviewer },
    ];
    const additionalProjects = (
      multiAgent ? configuredReviewerProjectIds : []
    ).flatMap((id) => {
      const project = projects.find((candidate) => candidate.id === id);
      return project ? [project] : [];
    });
    selectedReviewers.push(
      ...additionalProjects.map((project) => ({
        reviewer: project,
        projectId: project.id,
      })),
    );
    setConsulting(true);
    setConversationResults(selectedReviewers);
    setModal("conversations");
    const prompt = reviewPrompt(multiAgent);
    const results = await Promise.all(
      selectedReviewers.map(async (target): Promise<ConversationResult> => {
        try {
          const sessionId = await xangiApi.createSession(target.projectId);
          await xangiApi.sendMessage(sessionId, prompt);
          return { ...target, sessionId };
        } catch (cause) {
          return { ...target, error: (cause as Error).message };
        }
      }),
    );
    setConversationResults(results);
    setConsulting(false);
  }

  async function useSnapshot(snapshotId: string) {
    if (!review) return;
    try {
      const snapshot = await reviewApi.snapshot(review.id, snapshotId);
      const apply = () => {
        autosave.update(cleanText(snapshot.content));
        setEditorReset((v) => v + 1);
        setModal(null);
        switchMode("edit");
        setNotice(
          "履歴の内容を編集欄に読み込みました。反映するには「保存」を押してください。",
        );
      };
      guard(apply);
    } catch (err) {
      setError((err as Error).message);
      setModal(null);
    }
  }

  return (
    <ArtifactLayout
      page={modal === "import" ? "import" : "artifacts"}
      beforeNavigate={guard}
    >
      {error && (
        <div className="message error" role="alert">
          {error}
        </div>
      )}
      {(importing || pdfImporting) && (
        <div className="message notice" role="status">
          <LoaderCircle size={16} className="spin" />
          {importing
            ? "GitHubからファイルを取り込み中です。"
            : "資料を取得・変換中です。"}
          他の成果物も閲覧できます。完了した内容は成果物一覧に表示されます。
        </div>
      )}
      {notice && (
        <div className="message notice" role="status">
          <Check size={16} />
          {notice}
        </div>
      )}
      {selectedPrItems[0]?.changeSet?.kind !== "github-repository" &&
        (selectedPr || !review || showFiles) && (
          <div className="detail-file-controls">
            <button
              type="button"
              aria-expanded={showFiles}
              onClick={() => setShowFiles(!showFiles)}
            >
              {showFiles ? "ファイル一覧を閉じる" : "ファイル一覧を開く"}
            </button>
          </div>
        )}
      <div
        className={`workspace ${showFiles ? "show-files" : "show-content"} ${selectedPr ? "pr-overview-workspace" : ""} ${selectedPrItems[0]?.changeSet?.kind === "github-repository" ? "repository-workspace" : ""}`}
      >
        <aside
          id="review-file-navigation"
          className="sidebar"
          aria-label="変更セット一覧"
        >
          <div className="sidebar-title">
            {mobile && selectedPr && (
              <button onClick={() => setShowFiles(false)}>差分に戻る</button>
            )}
            <span>
              {selectedPr
                ? "変更ファイル"
                : review
                  ? "選択中の成果物"
                  : "成果物"}
            </span>
            {!selectedPr && !review && (
              <span className="count">{changeSetCount}</span>
            )}
          </div>
          <label className="search-box">
            <Search size={16} />
            <input
              aria-label="ファイルを検索"
              placeholder="ファイルを探す"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <nav className="file-list" aria-label="PRと変更ファイル">
            {reviewGroups.map((group, index) => {
              const focusedPr = selectedPr === group.key;
              const expanded =
                focusedPr ||
                Boolean(search.trim()) ||
                expandedGroup === group.key;
              const filesId = `change-set-files-${index}`;
              return (
                <section
                  className={`change-set-group ${focusedPr ? "focused-pr-files" : ""}`}
                  key={group.key}
                >
                  <div className="change-set-row">
                    {!focusedPr && (
                      <button
                        className="change-set-header"
                        type="button"
                        aria-expanded={expanded}
                        aria-controls={filesId}
                        onClick={() => {
                          if (
                            ["github-pr", "github-repository"].includes(
                              group.items[0]?.changeSet?.kind ?? "",
                            )
                          )
                            guard(() => openPullRequest(group.key));
                          else setExpandedGroup(expanded ? null : group.key);
                        }}
                      >
                        <ChevronRight
                          className="change-set-chevron"
                          size={16}
                          aria-hidden="true"
                        />
                        <span className="change-set-detail">
                          <span className="change-set-kicker">
                            <strong>{group.label}</strong>
                            <span>
                              {group.items.length}
                              {group.items[0]?.document ? "ページ" : "ファイル"}
                            </span>
                          </span>
                          {group.title !== group.label && (
                            <span className="change-set-title">
                              {group.title}
                            </span>
                          )}
                          <small>{group.source}</small>
                          {group.items[0]?.document && (
                            <span className="document-overview-preview">
                              {documentOverviews(group.items)
                                .map((e) => e.text)
                                .join(" / ") ||
                                "概要は再レビュー後に表示されます"}
                            </span>
                          )}
                        </span>
                      </button>
                    )}
                    {["github-pr", "github-repository"].includes(
                      group.items[0]?.changeSet?.kind ?? "",
                    ) && (
                      <button
                        type="button"
                        className="change-set-review"
                        title={`${group.label}全体をレビュー`}
                        aria-label={`${group.label}全体をレビュー`}
                        disabled={importing || Boolean(reviewingTarget)}
                        onClick={() =>
                          openReviewStart({
                            url: group.items[0].changeSet!.url,
                            revision: group.items[0].changeSet!.revision,
                            title: group.title,
                          })
                        }
                      >
                        <MessageCircle size={15} /> レビュー
                      </button>
                    )}
                    {["github-pr", "github-repository"].includes(
                      group.items[0]?.changeSet?.kind ?? "",
                    ) && (
                      <button
                        type="button"
                        className="change-set-refresh"
                        title={`${group.label}の更新を確認`}
                        aria-label={`${group.label}の更新を確認`}
                        disabled={importing || Boolean(reviewingTarget)}
                        onClick={() =>
                          void checkPullRequest(group.items[0].changeSet!.url)
                        }
                      >
                        <RefreshCw
                          size={15}
                          className={
                            importingTarget?.url ===
                            group.items[0].changeSet!.url
                              ? "spin"
                              : ""
                          }
                        />
                      </button>
                    )}
                    {group.key !== "standalone" && (
                      <button
                        type="button"
                        className="change-set-archive"
                        title={`${group.label}を一覧から外す`}
                        aria-label={`${group.label}を一覧から外す`}
                        onClick={() => void setArchived(group.key, true)}
                      >
                        <Archive size={15} />
                      </button>
                    )}
                  </div>
                  {expanded && (
                    <div className="change-set-files" id={filesId}>
                      {["github-pr", "github-repository"].includes(
                        group.items[0]?.changeSet?.kind ?? "",
                      ) &&
                        !selectedPr && (
                          <button
                            className="pr-show-all"
                            onClick={() =>
                              guard(() => {
                                openPullRequest(group.key);
                                if (mobile) setShowFiles(false);
                              })
                            }
                          >
                            全体表示に戻る
                          </button>
                        )}
                      <ReviewFileTree
                        items={group.items}
                        selected={review?.id}
                        disabled={saving}
                        onSelect={(id) =>
                          guard(() => {
                            if (
                              ["github-pr", "github-repository"].includes(
                                group.items[0]?.changeSet?.kind ?? "",
                              )
                            ) {
                              if (selectedPr !== group.key)
                                openPullRequest(group.key);
                              if (mobile) setShowFiles(false);
                              requestAnimationFrame(() =>
                                setTimeout(
                                  () =>
                                    document
                                      .getElementById(`pr-file-${id}`)
                                      ?.scrollIntoView({
                                        behavior: "smooth",
                                        block: "start",
                                      }),
                                  0,
                                ),
                              );
                            } else
                              void openReview(
                                id,
                                group.items[0]?.changeSet?.kind === "workspace"
                                  ? "preview"
                                  : "diff",
                              );
                          })
                        }
                      />
                    </div>
                  )}
                </section>
              );
            })}
            {items.length > 0 && reviewGroups.length === 0 && (
              <p className="empty-list">一致するPR・ファイルはありません。</p>
            )}
          </nav>
          <button
            type="button"
            className="sidebar-settings"
            onClick={() => openSettings()}
          >
            <Settings2 size={16} />
            レビュー設定
          </button>
        </aside>
        <main className="main-panel">
          {review && (
            <>
              <header className="file-header">
                <div className="file-path">
                  <button
                    className="icon-button file-list-toggle"
                    aria-label="ファイル一覧を開く"
                    title="ファイル一覧を開く"
                    aria-expanded={showFiles}
                    aria-controls="review-file-navigation"
                    onClick={() => setShowFiles(true)}
                  >
                    <ArrowLeft size={20} />
                  </button>
                  <Files size={17} className="path-icon" />
                  <span>
                    {review.document
                      ? review.document.name
                      : review.file.split("/").slice(0, -1).join("/")}{" "}
                    <span className="path-separator">/</span>{" "}
                    <strong>
                      {review.document
                        ? `${review.document.page}ページ`
                        : fileName(review.file)}
                    </strong>
                  </span>
                </div>
                <div className="file-actions">
                  <button
                    className="icon-button"
                    title="レビュー設定"
                    aria-label="レビュー設定"
                    onClick={() => openSettings()}
                  >
                    <Settings2 size={18} />
                  </button>
                  <button
                    className="icon-button"
                    title="再読込"
                    aria-label="再読込"
                    disabled={saving || loading}
                    onClick={() =>
                      guard(() => void openReview(review.id, mode, true))
                    }
                  >
                    <RefreshCw size={17} />
                  </button>
                  <button
                    className="icon-button"
                    title="保存履歴"
                    aria-label="保存履歴"
                    disabled={saving}
                    onClick={() => setModal("history")}
                  >
                    <History size={18} />
                  </button>
                  <button
                    className="quiet-button share-button"
                    aria-label="リンク"
                    onClick={() => {
                      setCopied(false);
                      setModal("share");
                    }}
                  >
                    <Link2 size={17} />
                    <span>リンク</span>
                  </button>
                </div>
              </header>
              {review.changeSet?.kind === "github-pr" && (
                <PullRequestDescription
                  key={review.changeSet.url}
                  reviewId={review.id}
                />
              )}
              <div className="review-context">
                <span className={`source-badge ${review.source}`}>
                  <MessageCircle size={13} />
                  {reviewSourceLabel(review)}
                </span>
                {!review.document && (
                  <span className="review-title">{review.title}</span>
                )}
                {review.changeSet && !review.document && (
                  <a
                    href={review.changeSet.url}
                    target="_blank"
                    rel="noreferrer"
                    className="conversation-link"
                  >
                    {review.changeSet.kind === "github-pr"
                      ? `PR #${review.changeSet.id}`
                      : review.changeSet.source}{" "}
                    <ArrowRight size={13} />
                  </a>
                )}
                {(["github-pr", "github-repository"].includes(
                  review.changeSet?.kind ?? "",
                ) ||
                  review.document) && (
                  <button
                    type="button"
                    className="conversation-link review-action"
                    disabled={importing || Boolean(reviewingTarget)}
                    onClick={() => {
                      openReviewStart({
                        url: review.changeSet!.url,
                        revision: review.changeSet!.revision,
                        file: review.document ? undefined : review.file,
                        title: review.document
                          ? review.changeSet!.title
                          : review.file,
                      });
                    }}
                  >
                    {reviewingTarget === review.changeSet?.url ? (
                      <LoaderCircle size={13} className="spin" />
                    ) : (
                      <MessageCircle size={13} />
                    )}
                    {reviewingTarget === review.changeSet?.url
                      ? "AIレビュー中"
                      : review.document
                        ? "資料をレビュー"
                        : "このファイルをレビュー"}
                  </button>
                )}
                {["github-pr", "github-repository"].includes(
                  review.changeSet?.kind ?? "",
                ) && (
                  <button
                    type="button"
                    className="conversation-link"
                    disabled={importing || Boolean(reviewingTarget)}
                    onClick={() => void checkPullRequest(review.changeSet!.url)}
                  >
                    <RefreshCw
                      size={13}
                      className={
                        importingTarget?.url === review.changeSet?.url
                          ? "spin"
                          : ""
                      }
                    />
                    更新を確認
                  </button>
                )}
                {review.sourceUrl &&
                  review.sourceUrl !== review.changeSet?.url && (
                    <a
                      href={review.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="conversation-link"
                    >
                      会話へ <ArrowRight size={13} />
                    </a>
                  )}
                {review.document &&
                  notionExport(review.id, "資料全体をNotionに保存", true)}
              </div>
              {!review.document &&
                review.changeSet?.kind !== "github-pr" &&
                notionExport(review.id, "成果物をNotionに保存")}

              <div className="mode-toolbar">
                <div
                  className="mode-tabs"
                  role="tablist"
                  aria-label="表示モード"
                >
                  {(
                    [
                      { value: "preview", label: "表示", Icon: FileText },
                      ...(!review.document &&
                      review.changeSet?.kind !== "github-repository"
                        ? [
                            {
                              value: "diff",
                              label: "差分",
                              Icon: GitCompareArrows,
                            } as const,
                          ]
                        : []),
                      ...(!review.readOnly
                        ? [
                            {
                              value: "edit",
                              label: "編集",
                              Icon: PencilLine,
                            } as const,
                          ]
                        : []),
                    ] as const
                  ).map(({ value, label, Icon }) => (
                    <button
                      key={value}
                      role="tab"
                      id={`tab-${value}`}
                      aria-selected={mode === value}
                      aria-controls="file-content"
                      className={mode === value ? "active" : ""}
                      onClick={() => switchMode(value)}
                    >
                      <Icon size={16} />
                      {label}
                    </button>
                  ))}
                </div>
                {!review.document && (
                  <div
                    className="diff-stat"
                    aria-label={`追加${additions}行、削除${deletions}行`}
                  >
                    <span className="added">+{additions}</span>
                    <span className="removed">−{deletions}</span>
                  </div>
                )}
              </div>
            </>
          )}
          {review && (
            <ArtifactRequestsPanel
              key={review.id}
              reviewId={review.id}
              version={review.version}
              blockedReason={
                dirty
                  ? "未反映の下書きがあります。保存してから依頼してください。"
                  : saving
                    ? "保存を待ってください。"
                    : ""
              }
            />
          )}
          {!selectedPr && currentJobs.length > 0 && (
            <div className="review-jobs" aria-label="レビュワーの進捗">
              {currentJobs.map((currentJob) => (
                <div
                  key={currentJob.sessionId}
                  className={`message review-job-status ${currentJob.status === "failed" ? "error" : "notice"}`}
                  role="status"
                >
                  <strong>{currentJob.reviewer?.name ?? "レビュワー"}</strong>
                  {currentJob.group && (
                    <span>
                      {" "}
                      / {currentJob.group.index}/{currentJob.group.total}組
                    </span>
                  )}
                  {currentJob.file && (
                    <span> · {currentJob.file.split("/").at(-1)}</span>
                  )}
                  {" · "}
                  {currentJob.status === "running"
                    ? `AI${currentJob.purpose === "overview" ? "概要を作成" : "レビュー"}中 — 完了後に自動保存します`
                    : currentJob.status === "failed"
                      ? `AI${currentJob.purpose === "overview" ? "概要作成" : "レビュー"}失敗: ${currentJob.error}`
                      : currentJob.purpose === "overview"
                        ? "概要の作成が完了しました"
                        : `AIレビュー完了: ${currentJob.result?.updated}/${currentJob.files?.length ?? currentJob.result?.total}${review?.document ? "ページ" : "ファイル"}`}
                  {" · "}
                  <a
                    href={`/chat/${encodeURIComponent(currentJob.sessionId)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    レビュー会話を開く
                  </a>
                </div>
              ))}
            </div>
          )}
          {jobError && (
            <div className="message error" role="alert">
              {jobError}
            </div>
          )}
          {!selectedPr && reviewSessionId && !currentJob && (
            <a
              className="message notice"
              href={`/chat/${encodeURIComponent(reviewSessionId)}`}
              target="_blank"
              rel="noreferrer"
            >
              xangiのレビュー会話を開く <ExternalLink size={14} />
            </a>
          )}
          {loading ? (
            <div className="loading-state">
              <LoaderCircle className="spin" size={24} />
              <span>ファイルを開いています</span>
            </div>
          ) : selectedPr && selectedPrItems.length ? (
            <PullRequestView
              exportAction={notionExport(
                selectedPrItems[0].id,
                selectedPrItems[0].changeSet?.kind === "github-repository"
                  ? "リポジトリ全体をNotionに保存"
                  : "PR全体をNotionに保存",
              )}
              items={selectedPrItems}
              jobs={reviewJobs}
              onOpenFile={(id) => guard(() => void openReview(id))}
              onReviewFile={(item) =>
                openReviewStart({
                  url: item.changeSet!.url,
                  revision: item.changeSet!.revision,
                  file: item.file,
                  title: item.file,
                })
              }
              onReviewAll={() =>
                openReviewStart({
                  url: selectedPrItems[0].changeSet!.url,
                  revision: selectedPrItems[0].changeSet!.revision,
                  title: selectedPrItems[0].changeSet!.title,
                })
              }
              onGenerateOverview={() =>
                openReviewStart({
                  url: selectedPrItems[0].changeSet!.url,
                  revision: selectedPrItems[0].changeSet!.revision,
                  title: selectedPrItems[0].changeSet!.title,
                  purpose: "overview",
                })
              }
              onBackFiles={() => setShowFiles(true)}
            />
          ) : !review ? (
            <div className="empty-state">
              <FileText size={34} />
              <h1>ファイルを開く</h1>
              <p>
                {accessKey
                  ? "会話からファイルのリンクを開いてください。"
                  : "招待リンクから開くと、ファイルを確認・編集できます。"}
              </p>
            </div>
          ) : (
            <section
              id="file-content"
              role="tabpanel"
              aria-labelledby={`tab-${mode}`}
              className={`content-area mode-${mode}`}
            >
              {!review.document &&
                mode === "preview" &&
                explanations.length > 0 && (
                  <section
                    className="text-review-comments"
                    aria-label="文章のレビュー"
                  >
                    {explanations.map((item, index) => (
                      <article
                        key={`${review.id}-${review.version}-${index}`}
                        className={`document-note severity-${item.severity}`}
                      >
                        <h3>{item.heading}</h3>
                        <p>{item.summary}</p>
                        <p>{item.review}</p>
                      </article>
                    ))}
                  </section>
                )}
              {review.document ? (
                <DocumentPage
                  review={review}
                  pages={items.filter(
                    (item) => item.document?.id === review.document?.id,
                  )}
                  onSelect={(id) => void openReview(id, "preview")}
                />
              ) : mode === "diff" && (review.explanations?.length ?? 0) > 0 ? (
                <div
                  className={`diff-review-layout ${showExplanations ? "" : "notes-hidden"}`}
                >
                  {showExplanations && (
                    <aside className="change-notes" aria-label="差分の説明">
                      <div className="change-notes-heading">
                        <strong>説明とレビュー</strong>
                        <span>
                          {review.explanations?.length}箇所
                          {warningCount > 0 ? `・警告 ${warningCount}` : ""}
                        </span>
                      </div>
                      <div className="change-note-list">
                        {explanations.map((item, index) => (
                          <button
                            type="button"
                            className={`change-note severity-${item.severity ?? "info"} ${index === selectedExplanation ? "active" : ""}`}
                            key={`${item.newStart}-${index}`}
                            aria-pressed={index === selectedExplanation}
                            onClick={(event) => {
                              setSelectedExplanation(index);
                              setShowFullDiff(false);
                              if (mobile) setShowExplanations(false);
                              event.currentTarget.scrollIntoView({
                                behavior: "smooth",
                                block: "nearest",
                                inline: "center",
                              });
                            }}
                          >
                            <div className="change-note-index">{index + 1}</div>
                            <div>
                              {(item.severity === "warning" ||
                                item.severity === "danger") && (
                                <span className="review-warning">
                                  <AlertTriangle size={13} />
                                  {item.severity === "danger"
                                    ? "危険"
                                    : "要注意"}
                                </span>
                              )}
                              <h2>{item.heading}</h2>
                              <p>{item.summary}</p>
                              {item.impact && (
                                <small>影響：{item.impact}</small>
                              )}
                              {item.review && (
                                <p className="review-comment">
                                  レビュー：{item.review}
                                </p>
                              )}
                              <code>
                                {item.oldStart
                                  ? `変更前 ${item.oldStart}行`
                                  : "新規"}
                                {" → "}
                                {item.newStart
                                  ? `変更後 ${item.newStart}行`
                                  : "削除"}
                              </code>
                            </div>
                          </button>
                        ))}
                      </div>
                    </aside>
                  )}
                  <div className="diff-code-column">
                    <div className="explained-diff-toolbar">
                      <div className="explained-diff-location">
                        <button
                          type="button"
                          aria-expanded={showExplanations}
                          aria-label={
                            showExplanations
                              ? "説明一覧を閉じる"
                              : "説明一覧を開く"
                          }
                          onClick={() =>
                            setShowExplanations((current) => !current)
                          }
                        >
                          <Files size={15} />
                          {showExplanations ? "一覧を閉じる" : "説明一覧"}
                        </button>
                        <span>
                          {showFullDiff
                            ? "ファイル全体の差分"
                            : `説明 ${selectedExplanation + 1} / ${explanations.length}`}
                        </span>
                      </div>
                      <div className="explained-diff-actions">
                        <button
                          type="button"
                          onClick={() => setShowFullDiff((current) => !current)}
                        >
                          {showFullDiff
                            ? "対応する差分に戻る"
                            : "ファイル全体を見る"}
                        </button>
                      </div>
                    </div>
                    {showFullDiff ? (
                      <>
                        <div className="compare-heading">
                          <span>AI作業前</span>
                          <ArrowRight size={14} />
                          <span>
                            {dirty ? "現在の下書き（未反映）" : "現在の内容"}
                          </span>
                          {mobile && (
                            <span className="inline-label">縦に比較</span>
                          )}
                        </div>
                        <CodePane
                          key={`${review.id}-${mode}-${editorReset}`}
                          content={draft}
                          before={cleanText(review.before)}
                          file={review.file}
                          mode="diff"
                          readOnly={
                            review.readOnly || saving || !autosave.ready
                          }
                          mobile={mobile}
                          resetKey={`${review.id}-${editorReset}`}
                          onChange={(text) => {
                            autosave.update(text);
                            setNotice("");
                          }}
                        />
                      </>
                    ) : (
                      activeExplanation && (
                        <div className="focused-review-content">
                          <ExplanationDiff
                            before={cleanText(review.before)}
                            after={draft}
                            explanation={activeExplanation}
                          />
                        </div>
                      )
                    )}
                  </div>
                </div>
              ) : mode === "preview" && /\.html?$/i.test(review.file) ? (
                <HtmlPreview
                  id={review.id}
                  file={review.file}
                  content={draft}
                />
              ) : mode === "preview" && /\.md$/i.test(review.file) ? (
                <article className="markdown-body">
                  <Markdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      a: ({ children, ...props }) => (
                        <a {...props} target="_blank" rel="noreferrer">
                          {children}
                        </a>
                      ),
                      img: ({ alt }) => (
                        <span className="image-placeholder">
                          {alt || "画像"}
                        </span>
                      ),
                    }}
                  >
                    {draft}
                  </Markdown>
                </article>
              ) : (
                <>
                  {mode === "diff" && (
                    <div className="compare-heading">
                      <span>AI作業前</span>
                      <ArrowRight size={14} />
                      <span>
                        {dirty ? "現在の下書き（未反映）" : "現在の内容"}
                      </span>
                      {mobile && <span className="inline-label">縦に比較</span>}
                    </div>
                  )}
                  <CodePane
                    key={`${review.id}-${mode}-${editorReset}`}
                    content={draft}
                    before={cleanText(review.before)}
                    file={review.file}
                    mode={
                      (review.readOnly && mode === "edit") ||
                      mode === "preview" ||
                      (!review.readOnly && (saving || !autosave.ready))
                        ? "read"
                        : mode
                    }
                    readOnly={review.readOnly || saving || !autosave.ready}
                    mobile={mobile}
                    resetKey={`${review.id}-${editorReset}`}
                    onChange={(text) => {
                      autosave.update(text);
                      setNotice("");
                    }}
                  />
                </>
              )}
            </section>
          )}
          {review && !review.readOnly && (
            <DraftStatusBar
              autosave={autosave}
              actionError={error}
              characterCount={Array.from(draft).length}
              actions={
                <>
                  <button
                    disabled={!dirty || saving || loading || !autosave.ready}
                    onClick={() => void save()}
                  >
                    {saving ? "保存中" : "保存"}
                  </button>
                </>
              }
            />
          )}
        </main>
      </div>
      {reReviewOpen && reviewTarget && (
        <div className="modal-backdrop">
          <Modal
            title={
              reviewTarget.purpose === "overview"
                ? "概要を作成"
                : "レビューを開始"
            }
            onClose={() => setReReviewOpen(false)}
          >
            <p>
              対象：{reviewTarget.title}（
              {reviewTarget.file ? "このファイルのみ" : "取り込んだ版の全体"}）
            </p>
            <p>
              原稿は変更しません。完了済みでも、開始すると新しくAIを実行します。
            </p>
            {reviewTarget.purpose === "overview" ? (
              <p>目的と構成図を作成します。レビューは実行しません。</p>
            ) : (
              <>
                <label htmlFor="review-instruction">
                  レビューの指示・観点・参考資料（任意）
                </label>
                <textarea
                  id="review-instruction"
                  rows={5}
                  maxLength={12000}
                  value={reviewInstruction}
                  disabled={Boolean(reviewingTarget)}
                  onChange={(e) => setReviewInstruction(e.target.value)}
                  placeholder="例：仕様との整合性と境界値を重点的に確認してください"
                />
                <p>
                  空欄なら通常のレビューを行います。全体レビューの指示を変更すると、以前の全体レビューの結果を置き換えます。
                </p>
                {!reviewTarget.file && (
                  <p>
                    ファイルを分割して並列にレビューします。選択した各レビュワーが全ての分割範囲を確認します。
                  </p>
                )}
              </>
            )}
            <fieldset className="reviewer-settings">
              <legend>
                {reviewTarget.purpose === "overview"
                  ? "概要を作成する担当"
                  : "レビュワー"}
              </legend>
              {[
                { id: "xangi-default", name: "xangiのデフォルト" },
                ...projects,
              ].map((project) => (
                <label key={project.id}>
                  <input
                    type={
                      reviewTarget.purpose === "overview" ? "radio" : "checkbox"
                    }
                    name="reviewer"
                    checked={selectedReviewerIds.includes(project.id)}
                    onChange={(event) =>
                      setSelectedReviewerIds((current) =>
                        reviewTarget.purpose === "overview"
                          ? [project.id]
                          : event.target.checked
                            ? [...current, project.id]
                            : current.filter((id) => id !== project.id),
                      )
                    }
                  />
                  {project.name}
                </label>
              ))}
            </fieldset>
            <button
              disabled={
                Boolean(
                  reviewTarget.purpose === "overview"
                    ? overviewingTarget
                    : reviewingTarget,
                ) || selectedReviewerIds.length === 0
              }
              onClick={() => {
                setReReviewOpen(false);
                void reviewCurrentPullRequest(
                  reviewTarget.url,
                  reviewTarget.revision,
                  reviewTarget.file,
                  reviewTarget.purpose,
                );
              }}
            >
              {reviewTarget.purpose === "overview"
                ? "概要の作成を開始する"
                : "レビューを開始する"}
            </button>
          </Modal>
        </div>
      )}
      {modal && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setModal(null);
          }}
        >
          <Modal
            title={
              modal === "import"
                ? "PR・リポジトリ・資料を取り込む"
                : modal === "share"
                  ? "会話にリンクを戻す"
                  : modal === "history"
                    ? "保存履歴"
                    : modal === "settings"
                      ? "レビュー設定"
                      : modal === "conversations"
                        ? "xangiでレビュー"
                        : "未保存の変更があります"
            }
            onClose={() => setModal(null)}
          >
            {modal === "import" && (
              <section className="import-dialog-content">
                <p>
                  取り込みだけではAIを実行しません。取り込み後にレビュー・編集を選んで指示できます。そのまま閲覧・保存もできます。
                </p>
                {error && <p role="alert">{error}</p>}
                <form
                  className="pr-import"
                  onSubmit={(event) => void importPullRequest(event)}
                >
                  <label htmlFor="pr-url">
                    GitHub PR・リポジトリを取り込む
                  </label>
                  <div>
                    <input
                      id="pr-url"
                      type="url"
                      inputMode="url"
                      placeholder="https://github.com/…/pull/123"
                      value={pullRequestUrl}
                      disabled={importing}
                      onChange={(event) =>
                        setPullRequestUrl(event.target.value)
                      }
                    />
                    <button
                      type="submit"
                      disabled={importing || !pullRequestUrl.trim()}
                    >
                      {importingTarget?.fromForm ? (
                        <LoaderCircle size={16} className="spin" />
                      ) : (
                        "取込"
                      )}
                    </button>
                  </div>
                </form>
                <div className="pr-import pdf-import">
                  <label htmlFor="pdf-file">資料ファイルを取り込む</label>
                  <input
                    ref={importFileInput}
                    id="pdf-file"
                    type="file"
                    accept=".pdf,.pptx,.docx,.doc"
                    disabled={pdfImporting}
                    onChange={(event) => {
                      setImportFile(event.target.files?.[0]);
                    }}
                  />
                  <button
                    type="button"
                    disabled={pdfImporting || !importFile}
                    onClick={() => void importPdf(importFile)}
                  >
                    資料を取り込む
                  </button>
                  <small>
                    {pdfImporting
                      ? "ページを変換中…"
                      : "PDF・PPTX・DOCX・DOC。100MB・100ページまで。"}
                  </small>
                </div>
                <form
                  className="pr-import"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void importPdf(undefined, googleUrl);
                  }}
                >
                  <label htmlFor="google-url">
                    Googleスライド・ドキュメント
                  </label>
                  <div>
                    <input
                      id="google-url"
                      type="url"
                      value={googleUrl}
                      onChange={(e) => setGoogleUrl(e.target.value)}
                      placeholder="https://docs.google.com/…"
                      disabled={pdfImporting}
                    />
                    <button disabled={pdfImporting || !googleUrl.trim()}>
                      取込
                    </button>
                  </div>
                </form>
              </section>
            )}
            {modal === "share" && (
              <>
                <p className="modal-description">
                  同じファイルを、PCでもスマホでも開けます。リンクを受け取った人は、このワークスペースを編集できます。
                </p>
                <label className="select-label">
                  貼り付け先
                  <select
                    value={platform}
                    onChange={(e) => {
                      setPlatform(e.target.value as Platform);
                      setCopied(false);
                    }}
                  >
                    {(["web", "discord", "slack"] as const).map((p) => (
                      <option key={p} value={p}>
                        {platformName[p]}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={16} />
                </label>
                <textarea
                  ref={textArea}
                  className="share-text"
                  aria-label="共有するリンク"
                  readOnly
                  value={shareText}
                  onFocus={(e) => e.target.select()}
                />
                <button
                  className="save-button full-width"
                  onClick={() => void copy()}
                >
                  {copied ? <Check size={17} /> : <Link2 size={17} />}
                  {copied ? "コピーしました" : "リンクをコピー"}
                </button>
                <p className="modal-footnote">
                  このリンクは
                  {mode === "diff" ? "差分" : mode === "edit" ? "編集" : "表示"}
                  画面から開きます。
                </p>
              </>
            )}
            {modal === "history" && (
              <>
                <p className="modal-description">
                  過去の内容を編集欄へ読み込めます。「保存」を押すまでは元ファイルを変更しません。
                </p>
                <div className="history-list">
                  {[...(review?.history ?? [])].reverse().map((snapshot) => (
                    <button
                      key={snapshot.id}
                      onClick={() => void useSnapshot(snapshot.id)}
                    >
                      <span>
                        <strong>{snapshot.label}</strong>
                        <small>{dateLabel(snapshot.at)}</small>
                      </span>
                      <ArrowRight size={18} />
                    </button>
                  ))}
                </div>
              </>
            )}
            {modal === "settings" && (
              <form onSubmit={(event) => void saveReviewSettings(event)}>
                <p className="modal-description">
                  既定ではxangi本体と同じbackend・model・workspaceを使います。必要な場合だけエージェントを選んで上書きできます。
                </p>
                {settingsError && (
                  <p className="settings-error" role="alert">
                    {settingsError}
                  </p>
                )}
                <label className="settings-field">
                  <span>
                    既定のレビュワー <b>任意</b>
                  </span>
                  <select
                    value={defaultProjectId}
                    onChange={(event) => {
                      const id = event.target.value;
                      setDefaultProjectId(id);
                      setReviewerProjectIds((current) =>
                        current.filter((item) => item !== id),
                      );
                    }}
                  >
                    <option value="">xangiのデフォルトを使う</option>
                    {projects.map((project) => (
                      <option value={project.id} key={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </label>
                {defaultProjectId && (
                  <ProjectSummary
                    project={projects.find(
                      (project) => project.id === defaultProjectId,
                    )}
                  />
                )}
                {!defaultProjectId && (
                  <p className="settings-hint">
                    現在のxangiの既定backend・model・workspaceで新しい会話を作ります。
                  </p>
                )}
                <fieldset className="reviewer-settings">
                  <legend>追加のレビュー設定</legend>
                  <p>複数レビューで同時に使うエージェントを選びます。</p>
                  <div className="reviewer-project-list">
                    {projects
                      .filter((project) => project.id !== defaultProjectId)
                      .map((project) => (
                        <label key={project.id}>
                          <input
                            type="checkbox"
                            checked={reviewerProjectIds.includes(project.id)}
                            onChange={(event) =>
                              setReviewerProjectIds((current) =>
                                event.target.checked
                                  ? [...current, project.id]
                                  : current.filter((id) => id !== project.id),
                              )
                            }
                          />
                          <span>
                            <strong>{project.name}</strong>
                            <small>
                              {project.backend ?? "既定backend"} ·{" "}
                              {project.model ?? "既定model"} ·{" "}
                              {project.workspaceId ?? "default workspace"}
                            </small>
                          </span>
                        </label>
                      ))}
                  </div>
                </fieldset>
                {(preferences?.archivedChangeSets.length ?? 0) > 0 && (
                  <section className="archived-settings">
                    <h3>一覧から外したPR・資料</h3>
                    {preferences?.archivedChangeSets.map((changeSet) => (
                      <div key={changeSet.key}>
                        <span>
                          <strong>
                            {["github-pr", "github-repository"].includes(
                              changeSet.kind ?? "",
                            )
                              ? pullRequestLabel(changeSet)
                              : changeSet.title || "資料レビュー"}
                          </strong>
                          <small>{changeSet.title}</small>
                        </span>
                        <button
                          type="button"
                          onClick={() => void setArchived(changeSet.key, false)}
                        >
                          <RotateCcw size={14} />
                          戻す
                        </button>
                      </div>
                    ))}
                  </section>
                )}
                <p className="modal-footnote">
                  エージェントのbackend・model・個別指示は
                  <a href="/" target="_blank" rel="noreferrer">
                    xangiのエージェント設定 <ExternalLink size={12} />
                  </a>
                  で行えます。
                </p>
                <button
                  className="save-button full-width"
                  type="submit"
                  disabled={savingSettings}
                >
                  {savingSettings && (
                    <LoaderCircle size={16} className="spin" />
                  )}
                  {savingSettings ? "保存中" : "設定を保存"}
                </button>
              </form>
            )}
            {modal === "conversations" && (
              <>
                <p className="modal-description">
                  選んだ変更箇所と対応する差分を、エージェントごとの新しい会話へ送ります。
                </p>
                <div className="conversation-list" aria-live="polite">
                  {conversationResults.map((result) => (
                    <div key={result.reviewer.id}>
                      <span>
                        <strong>{result.reviewer.name}</strong>
                        <small>
                          {"backend" in result.reviewer
                            ? (result.reviewer.backend ?? "既定backend")
                            : "xangi既定backend"}{" "}
                          ·{" "}
                          {"model" in result.reviewer
                            ? (result.reviewer.model ?? "既定model")
                            : "xangi既定model"}
                        </small>
                      </span>
                      {result.sessionId ? (
                        <a
                          href={`/chat/${encodeURIComponent(result.sessionId)}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          会話を開く <ExternalLink size={13} />
                        </a>
                      ) : result.error ? (
                        <em>{result.error}</em>
                      ) : (
                        <span className="conversation-pending">
                          <LoaderCircle size={14} className="spin" /> 実行中
                        </span>
                      )}
                    </div>
                  ))}
                </div>
                {!consulting &&
                  conversationResults.some((result) => result.sessionId) && (
                    <p className="modal-footnote">
                      会話はxangiに保存されています。この画面を閉じても続けられます。
                    </p>
                  )}
              </>
            )}
            {modal === "discard" && (
              <>
                <p className="modal-description">
                  この操作を続けると、まだ保存していない編集内容を破棄します。
                </p>
                <div className="modal-buttons">
                  <button
                    className="quiet-button"
                    onClick={() => {
                      pendingAction.current = null;
                      setModal(null);
                    }}
                  >
                    編集を続ける
                  </button>
                  <button
                    className="danger-button"
                    onClick={() => {
                      const action = pendingAction.current;
                      pendingAction.current = null;
                      setModal(null);
                      action?.();
                    }}
                  >
                    破棄して続ける
                  </button>
                </div>
              </>
            )}
          </Modal>
        </div>
      )}
    </ArtifactLayout>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const elements = [
        ...(dialog.current?.querySelectorAll<HTMLElement>(
          "button, input, select, textarea, a[href]",
        ) ?? []),
      ].filter((e) => !e.hasAttribute("disabled"));
      if (event.shiftKey && document.activeElement === elements[0]) {
        event.preventDefault();
        elements.at(-1)?.focus();
      }
      if (!event.shiftKey && document.activeElement === elements.at(-1)) {
        event.preventDefault();
        elements[0]?.focus();
      }
    };
    addEventListener("keydown", trap);
    return () => {
      removeEventListener("keydown", trap);
      previous?.focus();
    };
  }, []);
  return (
    <div
      ref={dialog}
      className="modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      <div className="modal-heading">
        <h2 id="modal-title">{title}</h2>
        <button className="icon-button" aria-label="閉じる" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      {children}
    </div>
  );
}

function ProjectSummary({ project }: { project?: XangiProject }) {
  if (!project) return null;
  return (
    <dl className="project-summary">
      <div>
        <dt>backend</dt>
        <dd>{project.backend ?? "xangiの既定"}</dd>
      </div>
      <div>
        <dt>model</dt>
        <dd>{project.model ?? "backendの既定"}</dd>
      </div>
      <div>
        <dt>workspace</dt>
        <dd>{project.workspaceId ?? "default"}</dd>
      </div>
    </dl>
  );
}

const preferredTheme = localStorage.getItem("xangi-theme");
const darkTheme =
  preferredTheme === "dark" ||
  (preferredTheme !== "light" &&
    matchMedia("(prefers-color-scheme: dark)").matches);
document.documentElement.dataset.theme = darkTheme ? "dark" : "light";
document.documentElement.style.colorScheme = darkTheme ? "dark" : "light";

// Keep bookmarks to the retired session view pointing to the host conversation.
const legacySession = new URLSearchParams(location.search).get("session");
const hasStudioRoute = ["settings", "review", "pr", "import", "artifacts"].some(
  (key) => new URLSearchParams(location.search).has(key),
);
if (legacySession && !hasStudioRoute && !idFromUrl()) {
  location.replace(`/chat/${encodeURIComponent(legacySession)}`);
} else
  createRoot(document.getElementById("root")!).render(
    new URLSearchParams(location.search).has("settings") ? (
      <StudioSettings />
    ) : idFromUrl() ||
      prFromUrl() ||
      new URLSearchParams(location.search).has("import") ? (
      <App />
    ) : (
      <ArtifactLayout page="artifacts" home>
        <main className="artifact-welcome">
          <h1>成果物を選んでください</h1>
          <p>左の一覧からPR・資料・原稿を開けます。</p>
        </main>
      </ArtifactLayout>
    ),
  );
