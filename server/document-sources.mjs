import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { ApiError } from "./store.mjs";
const execute = promisify(execFile);
// Reuse the host workspace's Google credential wrapper when available.
export async function googleRunner(executable, args, options) {
  const workspace = process.env.XANGI_REVIEW_WORKSPACE;
  const wrapper =
    workspace &&
    resolve(workspace, "skills/xs-google-workspace/scripts/gog_exec.py");
  if (wrapper && existsSync(wrapper) && !process.env.XANGI_REVIEW_GOG) {
    const index = args.indexOf("--account");
    const account = index >= 0 ? args[index + 1] : "default";
    const rest = args.filter(
      (_, i) => index < 0 || (i !== index && i !== index + 1),
    );
    return execute(
      "uv",
      ["run", wrapper, "--account", account, "--", ...rest],
      options,
    );
  }
  return execute(executable, args, options);
}
const MAX_BYTES = 100 * 1024 * 1024;
export const documentFormat = (name) => extname(String(name)).toLowerCase();
export function parseGoogleDocument(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new ApiError(
      400,
      "GoogleスライドまたはドキュメントのURLを指定してください。",
    );
  }
  const match = /^\/(presentation|document)\/d\/([a-zA-Z0-9_-]+)(?:\/|$)/.exec(
    url.pathname,
  );
  if (
    url.protocol !== "https:" ||
    url.hostname !== "docs.google.com" ||
    url.port ||
    url.username ||
    url.password ||
    !match
  )
    throw new ApiError(
      400,
      "docs.google.comのスライドまたはドキュメントのURLを指定してください。",
    );
  return {
    id: match[2],
    kind: match[1],
    url: `https://docs.google.com/${match[1]}/d/${match[2]}/edit`,
  };
}
export async function officeToPdf(dir, format, bytes, runner = execute) {
  const input = resolve(dir, `original${format}`);
  await writeFile(input, bytes, { mode: 0o600 });
  const profile = resolve(dir, "office-profile");
  await mkdir(resolve(profile, "user"), { recursive: true, mode: 0o700 });
  await writeFile(
    resolve(profile, "user", "registrymodifications.xcu"),
    '<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item></oor:items>',
  );
  try {
    await runner(
      process.env.XANGI_REVIEW_SOFFICE ?? "libreoffice",
      [
        `-env:UserInstallation=${pathToFileURL(profile).href}`,
        "--headless",
        "--norestore",
        "--nodefault",
        "--convert-to",
        "pdf",
        "--outdir",
        dir,
        input,
      ],
      { timeout: 60_000, maxBuffer: 512 * 1024 },
    );
    const output = resolve(dir, "original.pdf");
    if ((await stat(output)).size > MAX_BYTES)
      throw new ApiError(413, "変換後のPDFが100MBを超えています。");
    const pdf = await readFile(output);
    if (!pdf.subarray(0, 5).equals(Buffer.from("%PDF-")))
      throw new Error("invalid PDF");
    return output;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(
      422,
      e.code === "ENOENT"
        ? "Office変換に失敗しました。LibreOfficeの導入と文書の形式を確認してください。"
        : "Office変換に失敗しました。破損・暗号化・60秒の変換上限を確認してください。",
    );
  }
}
export async function exportGoogleDocument(
  input,
  dir,
  {
    account = process.env.XANGI_REVIEW_GOOGLE_ACCOUNT ||
      process.env.GOG_ACCOUNT,
    runner = googleRunner,
  } = {},
) {
  const source = parseGoogleDocument(input);
  const executable = process.env.XANGI_REVIEW_GOG ?? "gog";
  if (account === undefined) {
    let accounts;
    try {
      const { stdout } = await runner(
        executable,
        ["--json", "--no-input", "auth", "list"],
        { timeout: 30_000, maxBuffer: 512 * 1024 },
      );
      const raw = JSON.parse(stdout);
      accounts = (raw.accounts ?? [])
        .filter((a) => a.services?.includes("drive") && a.email)
        .map((a) => a.email);
    } catch {
      throw new ApiError(
        503,
        "xangiのGoogle認証設定を読み取れません。Google Workspaceのgog設定を確認してください。",
      );
    }
    let last;
    for (const email of accounts) {
      try {
        return await exportGoogleDocument(input, dir, {
          account: email,
          runner,
        });
      } catch (e) {
        if (e.status !== 422 || !/権限がありません|認証が失効/.test(e.message))
          throw e;
        last = e;
      }
    }
    if (last) throw last;
    throw new ApiError(
      503,
      "xangiにDrive認証済みのGoogleアカウントがありません。",
    );
  }
  if (!account) throw new ApiError(503, "Googleアカウントが空です。");
  const args = ["--account", account, "--no-input"];
  try {
    const { stdout } = await runner(
      executable,
      [...args, "--json", "--results-only", "drive", "get", source.id],
      { timeout: 30_000, maxBuffer: 512 * 1024 },
    );
    const raw = JSON.parse(stdout);
    const metadata = raw.file ?? raw;
    const expected =
      source.kind === "presentation"
        ? "application/vnd.google-apps.presentation"
        : "application/vnd.google-apps.document";
    const officeFormats =
      source.kind === "presentation"
        ? {
            "application/vnd.openxmlformats-officedocument.presentationml.presentation":
              ".pptx",
          }
        : {
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
              ".docx",
            "application/msword": ".doc",
          };
    const officeFormat = officeFormats[metadata.mimeType];
    if (metadata.mimeType !== expected && !officeFormat)
      throw new ApiError(
        415,
        "URLとGoogle資料の形式が一致しません。スライドまたはドキュメントを指定してください。",
      );
    if (Number(metadata.size) > MAX_BYTES)
      throw new ApiError(413, "Google資料の上限は100MBです。");
    let output = resolve(
      dir,
      officeFormat ? `google-source${officeFormat}` : "google-export.pdf",
    );
    await runner(
      executable,
      [
        ...args,
        "drive",
        "download",
        source.id,
        ...(officeFormat ? [] : ["--format", "pdf"]),
        "--out",
        output,
      ],
      { timeout: 60_000, maxBuffer: 512 * 1024 },
    );
    if ((await stat(output)).size > MAX_BYTES)
      throw new ApiError(413, "Google資料が100MBを超えています。");
    if (officeFormat) {
      const bytes = await readFile(output);
      const signature =
        officeFormat === ".doc"
          ? Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
          : Buffer.from([0x50, 0x4b, 3, 4]);
      if (!bytes.subarray(0, signature.length).equals(signature))
        throw new ApiError(415, "Google資料の内容とOffice形式が一致しません。");
      output = await officeToPdf(dir, officeFormat, bytes);
    }
    return {
      bytes: await readFile(output),
      title: String(metadata.name ?? source.id).slice(0, 150),
      sourceUrl: source.url,
      source: source.kind === "presentation" ? "Google Slides" : "Google Docs",
    };
  } catch (e) {
    if (e instanceof ApiError) throw e;
    const detail = String(e.stderr ?? "");
    throw new ApiError(
      422,
      e.code === "ENOENT"
        ? "gogが見つかりません。Google取り込み用CLIを設定してください。"
        : /invalid_grant|unauthorized|401|expired|revoked/i.test(detail)
          ? "Google認証が失効しています。設定アカウントでgogを再認証してください。"
          : /403|404|notFound|permission/i.test(detail)
            ? "Google資料の閲覧・ダウンロード権限がありません。共有設定を確認してください。"
            : "Google資料を取得できません。認証・接続・Google側のPDF出力上限を確認してください。",
    );
  }
}
