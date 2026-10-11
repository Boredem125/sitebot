import { useState } from 'react';
import type { FormEvent } from 'react';
import { INSIGHT_LIMITS } from '@sitebot/shared';
import type { Site, UpdateSiteRequest } from '@sitebot/shared';
import { detectBrand, updateSite } from '../api';
import { Button, Notice } from '../components/ui';
import { contrastOn, errorMessage, isHexColor, safeColor } from '../lib/format';

const NAME_MAX = 80;
const GREETING_MAX = 200;
const INSTRUCTIONS_MAX = 2000;
const QUESTION_SLOTS = Array.from({ length: INSIGHT_LIMITS.suggestedQuestions }, (_, i) => i);

interface FormValues {
  name: string;
  greeting: string;
  color: string;
  position: Site['position'];
  instructions: string;
  domains: string;
  // Brand look. An empty string means "widget default".
  background: string;
  textColor: string;
  font: string;
  logoUrl: string;
  /** One entry per input, always QUESTION_SLOTS long. Empty ones are left out when saving. */
  suggestedQuestions: string[];
  leadCapture: boolean;
}

const LOOK_KEYS = ['background', 'textColor', 'font', 'logoUrl'] as const;

const toForm = (site: Site): FormValues => ({
  name: site.name,
  greeting: site.greeting,
  color: safeColor(site.color),
  position: site.position === 'left' ? 'left' : 'right',
  instructions: site.instructions,
  domains: site.domains.join('\n'),
  background: site.background ?? '',
  textColor: site.textColor ?? '',
  font: site.font ?? '',
  logoUrl: site.logoUrl ?? '',
  suggestedQuestions: QUESTION_SLOTS.map((i) => site.suggestedQuestions[i] ?? ''),
  leadCapture: site.leadCapture,
});

const filledQuestions = (questions: string[]): string[] => questions.map((q) => q.trim()).filter((q) => q !== '');

const optionalHex = (value: string): boolean => value.trim() === '' || isHexColor(value.trim());

/** Only https images are shown; anything else in the field is treated as no logo. */
function safeLogo(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

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
  for (const key of LOOK_KEYS) {
    const value = form[key].trim() || null;
    if (value !== site[key]) patch[key] = value;
  }
  const questions = filledQuestions(form.suggestedQuestions);
  if (!sameList(questions, site.suggestedQuestions)) patch.suggestedQuestions = questions;
  if (form.leadCapture !== site.leadCapture) patch.leadCapture = form.leadCapture;
  return patch;
}

type SaveState = { status: 'idle' } | { status: 'saving' } | { status: 'saved' } | { status: 'failed'; message: string };

export function AppearanceTab({ site, onSaved }: { site: Site; onSaved: (site: Site) => void }) {
  const [form, setForm] = useState<FormValues>(() => toForm(site));
  const [save, setSave] = useState<SaveState>({ status: 'idle' });

  const [detecting, setDetecting] = useState(false);

  const colorValid = isHexColor(form.color);
  const lookValid = optionalHex(form.background) && optionalHex(form.textColor);
  const patch = diff(site, form);
  const dirty = Object.keys(patch).length > 0;

  function set<K extends keyof FormValues>(key: K, value: FormValues[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }));
    setSave((prev) => (prev.status === 'saving' ? prev : { status: 'idle' }));
  }

  function setQuestion(index: number, value: string): void {
    set(
      'suggestedQuestions',
      form.suggestedQuestions.map((q, i) => (i === index ? value : q)),
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!dirty) return;
    if (!colorValid) {
      setSave({ status: 'failed', message: 'Enter the colour as a 6-digit hex value, like #4f46e5.' });
      return;
    }
    if (!lookValid) {
      setSave({ status: 'failed', message: 'Background and text colours must be 6-digit hex values, or empty.' });
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

  async function onDetect(): Promise<void> {
    setDetecting(true);
    setSave({ status: 'idle' });
    try {
      const updated = await detectBrand(site.id);
      onSaved(updated);
      // Unsaved edits to the other fields stay; only the look comes from the site.
      setForm((prev) => ({
        ...prev,
        color: safeColor(updated.color),
        background: updated.background ?? '',
        textColor: updated.textColor ?? '',
        font: updated.font ?? '',
        logoUrl: updated.logoUrl ?? '',
      }));
      setSave({ status: 'saved' });
    } catch (err) {
      setSave({ status: 'failed', message: errorMessage(err) });
    } finally {
      setDetecting(false);
    }
  }

  return (
    <div className="appearance">
      <form className="card stack" onSubmit={(e) => void onSubmit(e)} aria-labelledby="appearance-title">
        <h2 id="appearance-title">Appearance and behaviour</h2>

        <div className="match-row">
          <div>
            <strong>Match my site</strong>
            <p className="hint">
              Reads the colours, font, and logo from {site.domains[0] ?? 'your site'} and applies them to the
              widget. You can still change every value below.
            </p>
          </div>
          <Button type="button" busy={detecting} onClick={() => void onDetect()}>
            Detect from site
          </Button>
        </div>

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

        <fieldset className="field">
          <legend>Suggested questions</legend>
          {QUESTION_SLOTS.map((i) => (
            <input
              key={i}
              type="text"
              maxLength={INSIGHT_LIMITS.suggestedQuestionMaxChars}
              aria-label={`Suggested question ${i + 1}`}
              aria-describedby="ap-questions-hint"
              placeholder={i === 0 ? 'What does it cost?' : undefined}
              value={form.suggestedQuestions[i] ?? ''}
              onChange={(e) => setQuestion(i, e.target.value)}
            />
          ))}
          <p id="ap-questions-hint" className="hint">
            Shown as buttons under the greeting, so visitors can start with one click. Leave them empty and they
            are filled in automatically from your content.
          </p>
        </fieldset>

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

        <div className="form-row">
          <div className="field">
            <label htmlFor="ap-background">Background colour</label>
            <input
              id="ap-background"
              type="text"
              className="input-hex"
              spellCheck={false}
              autoCapitalize="none"
              maxLength={7}
              placeholder="#ffffff"
              aria-invalid={!optionalHex(form.background) || undefined}
              value={form.background}
              onChange={(e) => set('background', e.target.value.trim())}
            />
          </div>
          <div className="field">
            <label htmlFor="ap-text">Text colour</label>
            <input
              id="ap-text"
              type="text"
              className="input-hex"
              spellCheck={false}
              autoCapitalize="none"
              maxLength={7}
              placeholder="Automatic"
              aria-invalid={!optionalHex(form.textColor) || undefined}
              value={form.textColor}
              onChange={(e) => set('textColor', e.target.value.trim())}
            />
          </div>
        </div>

        <div className="form-row">
          <div className="field">
            <label htmlFor="ap-font">Font</label>
            <input
              id="ap-font"
              type="text"
              maxLength={60}
              placeholder="System font"
              aria-describedby="ap-font-hint"
              value={form.font}
              onChange={(e) => set('font', e.target.value)}
            />
            <p id="ap-font-hint" className="hint">
              One family name your site already loads, for example Inter.
            </p>
          </div>
          <div className="field field-grow">
            <label htmlFor="ap-logo">Logo image URL</label>
            <input
              id="ap-logo"
              type="url"
              maxLength={500}
              spellCheck={false}
              placeholder="https://example.com/logo.svg"
              aria-describedby="ap-logo-hint"
              value={form.logoUrl}
              onChange={(e) => set('logoUrl', e.target.value)}
            />
            <p id="ap-logo-hint" className="hint">
              Square works best. Shown on the chat button and in the header. Empty uses a chat icon.
            </p>
          </div>
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
          <label className="check">
            <input
              type="checkbox"
              aria-describedby="ap-lead-hint"
              checked={form.leadCapture}
              onChange={(e) => set('leadCapture', e.target.checked)}
            />
            <span>Ask for an email when the bot cannot answer</span>
          </label>
          <p id="ap-lead-hint" className="hint">
            The emails appear under Questions. You are responsible for telling your visitors how their address is
            used, for example in your privacy policy.
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
        name={form.name.trim() || site.name}
        greeting={form.greeting.trim()}
        color={colorValid ? form.color : safeColor(site.color)}
        background={isHexColor(form.background.trim()) ? form.background.trim() : '#ffffff'}
        textColor={isHexColor(form.textColor.trim()) ? form.textColor.trim() : null}
        font={form.font.trim()}
        logoUrl={safeLogo(form.logoUrl)}
        position={form.position}
        questions={filledQuestions(form.suggestedQuestions)}
      />
    </div>
  );
}

interface PreviewProps {
  name: string;
  greeting: string;
  color: string;
  background: string;
  textColor: string | null;
  font: string;
  logoUrl: string | null;
  position: Site['position'];
  questions: string[];
}

/** A static sketch of the widget. The real widget.js is never loaded into the dashboard. */
function Preview({ name, greeting, color, background, textColor, font, logoUrl, position, questions }: PreviewProps) {
  const [brokenLogo, setBrokenLogo] = useState<string | null>(null);
  const accent = safeColor(color);
  const onAccent = contrastOn(accent);
  const text = textColor ?? (contrastOn(background) === '#ffffff' ? '#f3f4f6' : '#111827');
  const logo = logoUrl && logoUrl !== brokenLogo ? logoUrl : null;
  // Only a plain family name reaches the style, so it cannot carry other CSS.
  const fontFamily = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,59}$/.test(font) ? `"${font}", system-ui, sans-serif` : undefined;
  const image = logo && (
    <img src={logo} alt="" referrerPolicy="no-referrer" onError={() => setBrokenLogo(logo)} />
  );

  return (
    <section className="card preview-card" aria-labelledby="preview-title">
      <h2 id="preview-title">Preview</h2>
      <div className={`preview preview-${position}`} aria-hidden="true">
        <div className="pv-panel" style={{ backgroundColor: background, color: text, fontFamily }}>
          <div className="pv-header" style={{ backgroundColor: accent, color: onAccent }}>
            {image}
            <span>{name}</span>
          </div>
          <div className="pv-body">
            {greeting && <div className="pv-bubble pv-bot">{greeting}</div>}
            {questions.length > 0 && (
              <div className="pv-pills">
                {questions.map((question, i) => (
                  <span key={i} className="pv-pill">
                    {question}
                  </span>
                ))}
              </div>
            )}
            <div className="pv-bubble pv-user" style={{ backgroundColor: accent, color: onAccent }}>
              How do I get started?
            </div>
            <div className="pv-bubble pv-bot">
              <strong>Two steps:</strong> sign up, then add your site.
            </div>
          </div>
        </div>
        <div
          className="pv-launcher"
          style={
            logo
              ? { backgroundColor: background, boxShadow: `inset 0 0 0 2px ${accent}, 0 4px 14px rgb(0 0 0 / 25%)` }
              : { backgroundColor: accent, color: onAccent }
          }
        >
          {image ?? (
            <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
              <path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-9l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" />
            </svg>
          )}
        </div>
      </div>
      <p className="hint">
        A sketch of the chat on the {position} side of your page. The font shows here only if this browser has
        it. Changes appear on your site after you save.
      </p>
    </section>
  );
}
