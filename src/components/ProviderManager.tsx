import { KeyRound, Plus, ShieldCheck, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ProviderConfig, ProviderInput } from "../domain/providers";

export function ProviderManager({
  open,
  providers,
  selectedProviderId,
  onClose,
  onSelect,
  onSave,
  onDelete
}: {
  open: boolean;
  providers: ProviderConfig[];
  selectedProviderId: string;
  onClose: () => void;
  onSelect: (id: string) => void;
  onSave: (input: ProviderInput, id?: string) => Promise<ProviderConfig>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [draftId, setDraftId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [removeApiKey, setRemoveApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftProvider = useMemo(
    () => providers.find((provider) => provider.id === draftId) ?? null,
    [draftId, providers]
  );

  function edit(provider: ProviderConfig | null) {
    setDraftId(provider?.id ?? null);
    setName(provider?.name ?? "");
    setBaseUrl(provider?.baseUrl ?? "");
    setApiKey("");
    setRemoveApiKey(false);
    setError(null);
  }

  useEffect(() => {
    if (!open) return;
    edit(providers.find((provider) => provider.id === selectedProviderId) ?? providers[0] ?? null);
  }, [open]);

  if (!open) return null;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const input: ProviderInput = { name, baseUrl };
      if (apiKey.trim()) input.apiKey = apiKey;
      else if (removeApiKey) input.apiKey = "";
      const provider = await onSave(input, draftId ?? undefined);
      onSelect(provider.id);
      edit(provider);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!draftProvider) return;
    if (!window.confirm(`Delete provider "${draftProvider.name}"? Its saved API key will also be removed.`)) return;
    setSaving(true);
    setError(null);
    try {
      await onDelete(draftProvider.id);
      const remaining = providers.filter((provider) => provider.id !== draftProvider.id);
      if (selectedProviderId === draftProvider.id) onSelect(remaining[0]?.id ?? "");
      edit(remaining[0] ?? null);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="provider-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section aria-label="Manage providers" aria-modal="true" className="provider-manager" role="dialog">
        <header className="provider-manager-header">
          <div>
            <p>Connection vault</p>
            <h2>Providers</h2>
          </div>
          <button aria-label="Close provider manager" className="provider-icon-button" type="button" onClick={onClose}>
            <X size={19} />
          </button>
        </header>

        <div className="provider-manager-body">
          <nav aria-label="Saved providers" className="provider-list">
            <button className="provider-add" type="button" onClick={() => edit(null)}>
              <Plus size={16} /> New provider
            </button>
            {providers.map((provider) => (
              <button
                className={provider.id === draftId ? "provider-list-item active" : "provider-list-item"}
                key={provider.id}
                type="button"
                onClick={() => edit(provider)}
              >
                <strong>{provider.name}</strong>
                <span>{new URL(provider.baseUrl).host}</span>
                <em>{provider.hasApiKey ? "Key saved" : "No key"}</em>
              </button>
            ))}
          </nav>

          <form className="provider-editor" onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}>
            <div className="provider-editor-heading">
              <div>
                <p>{draftProvider ? "Edit connection" : "New connection"}</p>
                <h3>{draftProvider?.name || "Provider details"}</h3>
              </div>
              {draftProvider ? (
                <button aria-label={`Delete provider ${draftProvider.name}`} className="provider-delete" disabled={saving} type="button" onClick={() => void remove()}>
                  <Trash2 size={16} /> Delete
                </button>
              ) : null}
            </div>

            <label className="field">
              <span>Display name</span>
              <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Azure production" />
            </label>
            <label className="field">
              <span>OpenAI-compatible base URL</span>
              <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://host/v1" />
            </label>
            <label className="field">
              <span><KeyRound size={14} /> API key</span>
              <input
                autoComplete="new-password"
                disabled={removeApiKey}
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={draftProvider?.hasApiKey ? "Leave blank to keep saved key" : "Optional"}
              />
            </label>
            {draftProvider?.hasApiKey ? (
              <label className="field checkbox-field provider-remove-key">
                <input checked={removeApiKey} type="checkbox" onChange={(event) => {
                  setRemoveApiKey(event.target.checked);
                  if (event.target.checked) setApiKey("");
                }} />
                <span>Remove saved API key</span>
              </label>
            ) : null}

            <div className="provider-security-note">
              <ShieldCheck size={18} />
              <p>Keys are held by your OS credential vault. Benchmark files contain only provider metadata and a redacted key marker.</p>
            </div>
            {error ? <p className="bench-error">{error}</p> : null}

            <div className="provider-editor-actions">
              <button className="secondary-action" type="button" onClick={onClose}>Close</button>
              <button className="primary-action" disabled={saving || !name.trim() || !baseUrl.trim()} type="submit">
                {saving ? "Saving…" : draftProvider ? "Save changes" : "Add provider"}
              </button>
            </div>
          </form>
        </div>
      </section>
    </div>
  );
}
