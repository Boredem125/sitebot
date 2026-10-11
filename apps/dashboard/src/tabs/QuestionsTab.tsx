import type { Site } from '@sitebot/shared';

/** Questions the bot could not answer, and the emails visitors left. */
export function QuestionsTab({ site }: { site: Site }) {
  return <p className="hint">Nothing here yet for {site.name}.</p>;
}
