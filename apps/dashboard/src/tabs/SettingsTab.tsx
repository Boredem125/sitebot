import type { Site } from '@sitebot/shared';

/** Site-level actions that do not fit elsewhere, such as deleting the site. */
export function SettingsTab({ site }: { site: Site }) {
  return <p className="hint">Nothing here yet for {site.name}.</p>;
}
