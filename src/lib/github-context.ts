/**
 * Parse the current GitHub page URL for speech-bubble prompt context.
 *
 * Runs in the content script, so `location` and `document` are the
 * active github.com page. Intentionally tolerant — unknown URL shapes
 * just degrade to `page: "other"` so the scheduler can skip the `repo`
 * kind gracefully.
 */

export type GithubPageKind =
  | "repo"
  | "profile"
  | "settings"
  | "home"
  | "other";

export interface GithubContext {
  owner: string | null;
  repo: string | null;
  section: string | null;
  page: GithubPageKind;
  title: string;
  description: string;
}

// Paths that look like /{owner}/{repo} but aren't actually repos.
const RESERVED_TOP_LEVEL = new Set([
  "settings",
  "notifications",
  "explore",
  "marketplace",
  "issues",
  "pulls",
  "search",
  "codespaces",
  "new",
  "login",
  "logout",
  "signup",
  "orgs",
  "organizations",
  "sponsors",
  "features",
  "pricing",
  "about",
  "topics",
  "collections",
  "trending",
]);

const PATH_RE =
  /^\/([^\/]+)(?:\/([^\/]+))?(?:\/(tree|blob|pull|pulls|issues|commits|actions|wiki|security|pulse|settings)(?:\/([^\/]+))?)?/;

export function getGithubContext(): GithubContext {
  const pathname = location.pathname;
  const match = PATH_RE.exec(pathname);

  const title = (document.title || "").slice(0, 200);
  const description =
    (
      document.querySelector('meta[name="description"]') as HTMLMetaElement | null
    )?.content?.slice(0, 300) ?? "";

  if (!match || pathname === "/") {
    return {
      owner: null,
      repo: null,
      section: null,
      page: pathname === "/" ? "home" : "other",
      title,
      description,
    };
  }

  const owner = match[1];
  const repo = match[2] ?? null;
  const section = match[3] ?? null;

  if (owner === "settings") {
    return { owner: null, repo: null, section, page: "settings", title, description };
  }
  if (RESERVED_TOP_LEVEL.has(owner)) {
    return { owner: null, repo: null, section, page: "other", title, description };
  }
  if (!repo) {
    return { owner, repo: null, section, page: "profile", title, description };
  }
  return { owner, repo, section, page: "repo", title, description };
}
