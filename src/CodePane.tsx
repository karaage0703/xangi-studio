import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { markdown } from "@codemirror/lang-markdown";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";

function language(file: string) {
  if (/\.md$/i.test(file)) return markdown();
  if (/\.[jt]sx?$/i.test(file))
    return javascript({
      typescript: /\.tsx?$/i.test(file),
      jsx: /x$/i.test(file),
    });
  if (/\.jsonl?$/i.test(file)) return json();
  return [];
}

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "14px", background: "var(--surface)" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    overflow: "auto",
    lineHeight: "1.8",
  },
  ".cm-content": { padding: "18px 0", caretColor: "var(--accent)" },
  ".cm-line": { padding: "0 18px" },
  ".cm-gutters": {
    background: "var(--surface)",
    color: "var(--muted)",
    border: "none",
    paddingLeft: "6px",
  },
  "&.cm-focused": { outline: "none" },
  // CodeMirror draws selections behind the content. Keep line fills translucent.
  ".cm-activeLine": { backgroundColor: "rgb(120 119 116 / 9%)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--subtle)" },
  "@media (max-width: 800px)": {
    "&": { fontSize: "16px" },
    ".cm-line": { padding: "0 10px" },
  },
});

type Props = {
  content: string;
  before?: string;
  file: string;
  mode: "edit" | "diff" | "read";
  readOnly?: boolean;
  mobile?: boolean;
  resetKey: string;
  onChange?: (text: string) => void;
};

export function CodePane({
  content,
  before = "",
  file,
  mode,
  readOnly = false,
  mobile,
  resetKey,
  onChange,
}: Props) {
  const parent = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const syncing = useRef(false);
  const onChangeRef = useRef(onChange);
  const contentRef = useRef(content);
  onChangeRef.current = onChange;
  contentRef.current = content;

  useEffect(() => {
    if (!parent.current) return;
    const readonly = readOnly || mode === "read";
    const extensions = (locked: boolean) => [
      basicSetup,
      theme,
      language(file),
      EditorView.lineWrapping,
      EditorState.readOnly.of(locked),
      EditorView.editable.of(!locked),
      EditorView.contentAttributes.of({
        "aria-label": locked ? "ファイルの内容" : "ファイルを編集",
        spellcheck: "false",
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !syncing.current)
          onChangeRef.current?.(update.state.doc.toString());
      }),
    ];
    if (mode === "diff" && !mobile) {
      const merge = new MergeView({
        a: { doc: before, extensions: extensions(true) },
        b: { doc: contentRef.current, extensions: extensions(readonly) },
        parent: parent.current,
        highlightChanges: true,
        gutter: true,
      });
      editor.current = merge.b;
      return () => {
        editor.current = null;
        merge.destroy();
      };
    }
    const view = new EditorView({
      doc: contentRef.current,
      parent: parent.current,
      extensions: [
        ...extensions(readonly),
        ...(mode === "diff"
          ? [
              unifiedMergeView({
                original: before,
                mergeControls: false,
                highlightChanges: true,
                gutter: true,
              }),
            ]
          : []),
      ],
    });
    editor.current = view;
    return () => {
      editor.current = null;
      view.destroy();
    };
  }, [before, file, mode, readOnly, mobile, resetKey]);

  useEffect(() => {
    const view = editor.current;
    if (!view || view.state.doc.toString() === content) return;
    syncing.current = true;
    try {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
      });
    } finally {
      syncing.current = false;
    }
  }, [content]);

  return <div ref={parent} className={`code-pane ${mode}`} />;
}
