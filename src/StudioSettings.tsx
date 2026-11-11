import { ArtifactLayout } from "./ArtifactLayout";
import { NotionSettings } from "./NotionSettings";
export function StudioSettings() {
  return (
    <ArtifactLayout page="settings">
      <main className="workspace-home">
        <h1>設定</h1>
        <section aria-labelledby="notion-settings-heading">
          <h2 id="notion-settings-heading">Notion保存</h2>
          <NotionSettings />
        </section>
      </main>
    </ArtifactLayout>
  );
}
