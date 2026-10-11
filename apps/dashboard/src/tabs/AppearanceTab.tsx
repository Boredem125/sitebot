import { useState } from 'react';
import type { FormEvent } from 'react';
import type { Site, UpdateSiteRequest } from '@sitebot/shared';
import { updateSite } from '../api';
import { Button, Notice } from '../components/ui';
import { contrastOn, errorMessage, isHexColor, safeColor } from '../lib/format';

const NAME_MAX = 80;
const GREETING_MAX = 200;
const INSTRUCTIONS_MAX = 2000;

interface FormValues {
  name: string;
  greeting: string;
  color: string;
  position: Site['position'];
  instructions: string;
  domains: string;
}

const toForm = (site: Site): FormValues => ({
  name: site.name,
  greeting: site.greeting,
  color: safeColor(site.color),
  position: site.position === 'left' ? 'left' : 'right',
  instructions: site.instructions,
  domains: site.domains.join('\n'),
});

/** One hostname per line. A pasted URL is reduced to its hostname. */
function parseDomains(text: string): string[] {
  const seen = new Set<string>();
  for (const line of text.split(/[\n,]/)) {
    let value = line.trim().toLowerCase();
    if (!value) continue;
    if (value.includes('://')) {
      try {
        value = new URL(value).hostname;
      } catch {
        // Keep it as typed: the server's validation message is more useful than a silent drop.
      }
    } else {
      value = value.replace(/\/.*$/, '');
    }
    if (value) seen.add(value);
  }
  return [...seen];
}

const sameList = (a: string[], b: string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/** Only the fields the owner actually changed, so a save never clobbers anything else. */
function diff(site: Site, form: FormValues): UpdateSiteRequest {
  const patch: UpdateSiteRequest = {};
  const name = form.name.trim();
  const greeting = form.greeting.trim();
  const instructions = form.instructions.trim();
  const domains = parseDomains(form.domains);
  if (name !== site.name) patch.name = name;
  if (greeting !== site.greeting) patch.greeting = greeting;
  if (form.color.toLowerCase() !== site.color.toLowerCase()) patch.color = form.color.toLowerCase();
  if (form.position !== site.position) patch.position = form.position;
  if (instructions !== site.instructions) patch.instructions = instructions;
  if (!sameList(domains, site.domains)) patch.domains = domains;
  return patch;
}

type SaveState = { status: 'idle' } | { status: 'saving' } | { status: 'saved' } | { status: 'failed'; message: string };

export function AppearanceTab({ site, onSaved }: { site: Site; onSaved: (site: Site) => void }) {
  const [form, setForm] = useState<FormValues>(() => toForm(site));
  const [save, setSave] = useState<SaveState>({ status: 'idle' });

  const colorValid = isHexColor(form.color);
  const patch = diff(site, form);
  const dirty = Object.keys(patch).length > 0;

  function set<K extends keyof FormValues>(key: K, value: FormValues[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }));
    setSave((prev) => (prev.status === 'saving' ? prev : { status: 'idle' }));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!dirty) return;
    if (!colorValid) {
      setSave({ status: 'failed', message: 'Enter the colour as a 6-digit hex value, like #4f46e5.' });
      return;
    }
    if (patch.domains && patch.domains.length === 0) {
      setSave({ status: 'failed', message: 'Add at least one domain, or the widget will not work anywhere.' });
      return;
    }
    setSave({ status: 'saving' });
    try {
      const updated = await updateSite(site.id, patch);
      onSaved(updated);
      setForm(toForm(updated));
      setSave({ status: 'saved' });
    } catch (err) {
      setSave({ status: 'failed', message: `Could not save. ${errorMessage(err)}` });
    }
  }

  return (
    <div className="appearance">
      <form className="card stack" onSubmit={(e) => void onSubmit(e)} aria-labelledby="appearance-title">
        <h2 id="appearance-title">Appearance and behaviour</h2>

        <div className="field">
          <label htmlFor="ap-name">Name</label>
          <input
            id="ap-name"
            type="text"
            required
            maxLength={NAME_MAX}
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
          />
        </div>

        <div className="field">
          <div className="label-row">
            <label htmlFor="ap-greeting">Greeting</label>
            <span className="counter">
              {form.greeting.length} / {GREETING_MAX}
            </span>
          </div>
          <input
            id="ap-greeting"
            type="text"
            maxLength={GREETING_MAX}
            value={form.greeting}
            onChange={(e) => set('greeting', e.target.value)}
          />
        </div>

        <div className="form-row">
          <fieldset className="field">
            <legend>Colour</legend>
            <div className="color-row">
              <input
                type="color"
                aria-label="Colour picker"
                value={colorValid ? form.color.toLowerCase() : safeColor(site.color)}
                onChange={(e) => set('color', e.target.value)}
              />
              <input
                type="text"
                className="input-hex"
                aria-label="Colour hex value"
                aria-invalid={!colorValid || undefined}
                spellCheck={false}
                autoCapitalize="none"
                maxLength={7}
                value={form.color}
                onChange={(e) => set('color', e.target.value.trim())}
              />
            </div>
          </fieldset>

          <fieldset className="field">
            <legend>Position</legend>
            <div className="seg seg-inline">
              {(['left', 'right'] as const).map((side) => (
                <label key={side} className="seg-item seg-radio">
                  <input
                    type="radio"
                    name="ap-position"
                    value={side}
                    checked={form.position === side}
                    onChange={() => set('position', side)}
                  />
                  <span>{side === 'left' ? 'Left' : 'Right'}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <div className="field">
          <div className="label-row">
            <label htmlFor="ap-instructions">Extra instructions</label>
            <span className="counter" aria-live="off">
              {form.instructions.length} / {INSTRUCTIONS_MAX}
            </span>
          </div>
          <textarea
            id="ap-instructions"
            rows={5}
            maxLength={INSTRUCTIONS_MAX}
            aria-describedby="ap-instructions-hint"
            placeholder="Keep answers short. If someone asks about pricing, point them to the pricing page."
            value={form.instructions}
            onChange={(e) => set('instructions', e.target.value)}
          />
          <p id="ap-instructions-hint" className="hint">
            Added to the bot's instructions. It still only answers from your content.
          </p>
        </div>

        <div className="field">
          <label htmlFor="ap-domains">Allowed domains</label>
          <textarea
            id="ap-domains"
            rows={3}
            spellCheck={false}
            autoCapitalize="none"
            aria-describedby="ap-domains-hint"
            placeholder="example.com"
            value={form.domains}
            onChange={(e) => set('domains', e.target.value)}
          />
          <p id="ap-domains-hint" className="hint">
            One per line. The widget works on these domains and their subdomains only.
          </p>
        </div>

        <div className="form-actions">
          <Button type="submit" variant="primary" busy={save.status === 'saving'} disabled={!dirty}>
            Save changes
          </Button>
          {save.status === 'saved' && <Notice kind="success">Saved.</Notice>}
          {save.status === 'failed' && <Notice kind="error">{save.message}</Notice>}
          {save.status === 'idle' && dirty && <span className="hint">Unsaved changes</span>}
        </div>
      </form>

      <Preview
        greeting={form.greeting.trim()}
        color={colorValid ? form.color : safeColor(site.color)}
        position={form.position}
      />
    </div>
  );
}

/** A static sketch of the widget. The real widget.js is never loaded into the dashboard. */
function Preview({ greeting, color, position }: { greeting: string; color: string; position: Site['position'] }) {
  const bg = safeColor(color);
  const fg = contrastOn(bg);
  return (
    <section className="card preview-card" aria-labelledby="preview-title">
      <h2 id="preview-title">Preview</h2>
      <div className="preview" aria-hidden="true">
        <div className="preview-page">
          <span className="preview-line preview-line-title" />
          <span className="preview-line" />
          <span className="preview-line" />
          <span className="preview-line preview-line-short" />
        </div>
        <div className={`preview-widget preview-${position}`}>
          {greeting && <div className="preview-greeting">{greeting}</div>}
          <div className="preview-launcher" style={{ backgroundColor: bg, color: fg }}>
            <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
              <path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-9l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" />
            </svg>
          </div>
        </div>
      </div>
      <p className="hint">
        A sketch of the launcher on the {position} side of your page. Changes appear on your site after you save.
      </p>
    </section>
  );
}
