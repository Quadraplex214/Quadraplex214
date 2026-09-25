const fs = require("node:fs");
const path = require("node:path");

const USERNAME = process.env.GITHUB_USERNAME || "Quadraplex214";
const API_ROOT = "https://api.github.com";
const OUTPUT_PATH = path.join(
  __dirname,
  "..",
  "assets",
  "repository-stats.svg",
);
const MAX_ATTEMPTS = 4;
const LANGUAGE_COLORS = [
  "#a78bfa",
  "#60a5fa",
  "#22d3ee",
  "#e879f9",
  "#818cf8",
  "#94a3b8",
];

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function retryDelay(response, attempt) {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1_000, 60_000);
  }

  const resetAt = Number(response.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(resetAt) && resetAt > 0) {
    const untilReset = resetAt * 1_000 - Date.now() + 1_000;
    return Math.max(1_000, Math.min(untilReset, 60_000));
  }

  return Math.min(2 ** attempt * 1_000, 15_000);
}

async function githubRequest(endpoint) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": `${USERNAME}-profile-stats`,
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);

    try {
      const response = await fetch(`${API_ROOT}${endpoint}`, {
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.ok && response.status !== 202) {
        return {
          data: await response.json(),
          headers: response.headers,
        };
      }

      const rateLimited =
        response.status === 429 ||
        (response.status === 403 &&
          response.headers.get("x-ratelimit-remaining") === "0");
      const retryable =
        response.status === 202 || rateLimited || response.status >= 500;

      let message = response.statusText;
      try {
        const body = await response.json();
        message = body.message || message;
      } catch {
        // A missing or non-JSON error body should not hide the HTTP status.
      }

      lastError = new Error(
        `GitHub API ${response.status} for ${endpoint}: ${message}`,
      );
      lastError.retryable = retryable;

      if (!retryable || attempt === MAX_ATTEMPTS) {
        throw lastError;
      }

      const delay = retryDelay(response, attempt);
      console.warn(
        `${lastError.message}. Retrying in ${Math.round(delay / 1_000)}s.`,
      );
      await sleep(delay);
    } catch (error) {
      clearTimeout(timeout);
      if (error.retryable === false) {
        throw error;
      }

      lastError =
        error.name === "AbortError"
          ? new Error(`GitHub API request timed out for ${endpoint}`)
          : error;

      if (attempt === MAX_ATTEMPTS) {
        throw lastError;
      }

      const delay = Math.min(2 ** attempt * 500, 5_000);
      console.warn(`${lastError.message}. Retrying in ${delay / 1_000}s.`);
      await sleep(delay);
    }
  }

  throw lastError;
}

async function getAllPages(endpoint) {
  const separator = endpoint.includes("?") ? "&" : "?";
  const records = [];

  for (let page = 1; ; page += 1) {
    const { data } = await githubRequest(
      `${endpoint}${separator}per_page=100&page=${page}`,
    );

    if (!Array.isArray(data)) {
      throw new Error(`Expected a list from GitHub API endpoint ${endpoint}`);
    }

    records.push(...data);
    if (data.length < 100) {
      return records;
    }
  }
}

function calculateLanguageShares(languageBytes) {
  const sorted = Object.entries(languageBytes)
    .filter(([, bytes]) => Number.isFinite(bytes) && bytes > 0)
    .sort((a, b) => b[1] - a[1]);

  if (sorted.length === 0) {
    return [];
  }

  const visible = sorted.slice(0, 5);
  if (sorted.length > 5) {
    visible.push([
      "Other",
      sorted.slice(5).reduce((sum, [, bytes]) => sum + bytes, 0),
    ]);
  }

  const total = visible.reduce((sum, [, bytes]) => sum + bytes, 0);
  const scaled = visible.map(([name, bytes]) => {
    const exact = (bytes / total) * 1_000;
    return {
      name,
      bytes,
      tenths: Math.floor(exact),
      remainder: exact - Math.floor(exact),
    };
  });

  const unassigned = 1_000 - scaled.reduce((sum, item) => sum + item.tenths, 0);
  const byRemainder = [...scaled].sort((a, b) => b.remainder - a.remainder);
  for (let index = 0; index < unassigned; index += 1) {
    byRemainder[index % byRemainder.length].tenths += 1;
  }

  return scaled.map((item, index) => ({
    ...item,
    percentage: item.tenths / 10,
    color: LANGUAGE_COLORS[index],
  }));
}

function formatCount(value) {
  return new Intl.NumberFormat("en-US", {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

function renderSvg(stats) {
  const metrics = [
    ["PUBLIC REPOS", stats.publicRepositories],
    ["SOURCE PROJECTS", stats.sourceRepositories],
    ["STARS EARNED", stats.stars],
    ["FORKS", stats.forks],
  ];

  const metricCards = metrics
    .map(([label, value], index) => {
      const x = 48 + index * 201;
      return `
      <g transform="translate(${x} 112)">
        <rect width="185" height="82" rx="14" fill="#11111d" stroke="#28243f"/>
        <rect x="1" y="1" width="3" height="80" rx="2" fill="${index % 2 ? "#60a5fa" : "#8b5cf6"}" opacity=".85"/>
        <text x="20" y="29" class="label">${label}</text>
        <text x="20" y="62" class="metric">${escapeXml(formatCount(value))}</text>
      </g>`;
    })
    .join("");

  let cursor = 48;
  const barWidth = 804;
  const languageBar = stats.languages
    .map((language, index) => {
      const width =
        index === stats.languages.length - 1
          ? 48 + barWidth - cursor
          : (language.percentage / 100) * barWidth;
      const segment = `<rect x="${cursor.toFixed(2)}" y="265" width="${Math.max(
        width,
        1,
      ).toFixed(2)}" height="14" fill="${language.color}"/>`;
      cursor += width;
      return segment;
    })
    .join("");

  const languageLegend =
    stats.languages.length > 0
      ? stats.languages
          .map((language, index) => {
            const column = index % 3;
            const row = Math.floor(index / 3);
            const x = 48 + column * 268;
            const y = 319 + row * 43;
            return `
      <g transform="translate(${x} ${y})">
        <rect y="-10" width="10" height="10" rx="3" fill="${language.color}"/>
        <text x="20" class="language">${escapeXml(language.name)}</text>
        <text x="242" text-anchor="end" class="percentage">${language.percentage.toFixed(1)}%</text>
      </g>`;
          })
          .join("")
      : '<text x="48" y="330" class="muted">No language data is available yet.</text>';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="414" viewBox="0 0 900 414" role="img" aria-labelledby="title description">
  <title id="title">${escapeXml(USERNAME)} repository statistics</title>
  <desc id="description">${stats.publicRepositories} public repositories, ${stats.sourceRepositories} source projects, ${stats.stars} stars, ${stats.forks} forks, with language distribution calculated from repository bytes.</desc>
  <defs>
    <linearGradient id="border" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#8b5cf6"/>
      <stop offset=".46" stop-color="#312e81"/>
      <stop offset="1" stop-color="#2563eb"/>
    </linearGradient>
    <radialGradient id="glow" cx="0" cy="0" r="1" gradientTransform="translate(730 45) rotate(145) scale(360 220)">
      <stop stop-color="#4f46e5" stop-opacity=".18"/>
      <stop offset="1" stop-color="#0a0a12" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="language-clip">
      <rect x="48" y="265" width="804" height="14" rx="7"/>
    </clipPath>
    <style>
      text { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
      .eyebrow { fill: #a78bfa; font-size: 12px; font-weight: 700; letter-spacing: 2px; }
      .heading { fill: #f8fafc; font-size: 25px; font-weight: 700; letter-spacing: -.6px; }
      .label { fill: #8b91a7; font-size: 10px; font-weight: 700; letter-spacing: 1.25px; }
      .metric { fill: #f4f1ff; font-size: 26px; font-weight: 700; }
      .section { fill: #d8d5e5; font-size: 12px; font-weight: 700; letter-spacing: 1.3px; }
      .language { fill: #d7d9e3; font-size: 13px; font-weight: 600; }
      .percentage { fill: #8f95aa; font-size: 12px; }
      .muted { fill: #747b91; font-size: 12px; }
    </style>
  </defs>
  <rect x="1" y="1" width="898" height="412" rx="22" fill="#0a0a12" stroke="url(#border)" stroke-width="2"/>
  <rect x="2" y="2" width="896" height="410" rx="21" fill="url(#glow)"/>
  <path d="M650 1H899V170" fill="none" stroke="#818cf8" stroke-opacity=".07"/>
  <path d="M700 1H899V120" fill="none" stroke="#38bdf8" stroke-opacity=".06"/>

  <text x="48" y="43" class="eyebrow">QUADRAPLEX214 / REPOSITORY INDEX</text>
  <text x="48" y="79" class="heading">Building in public, measured honestly.</text>
  <circle cx="839" cy="49" r="4" fill="#22d3ee"/>
  <circle cx="839" cy="49" r="10" fill="none" stroke="#22d3ee" stroke-opacity=".2"/>

  ${metricCards}

  <text x="48" y="235" class="section">LANGUAGES / BY BYTES</text>
  <g clip-path="url(#language-clip)">
    <rect x="48" y="265" width="804" height="14" fill="#1c1b29"/>
    ${languageBar}
  </g>

  ${languageLegend}
</svg>
`;
}

async function collectStats() {
  const [{ data: user }, repositories] = await Promise.all([
    githubRequest(`/users/${encodeURIComponent(USERNAME)}`),
    getAllPages(
      `/users/${encodeURIComponent(USERNAME)}/repos?type=owner&sort=full_name`,
    ),
  ]);

  const sourceRepositories = repositories.filter(
    (repository) =>
      !repository.fork &&
      !repository.archived &&
      !repository.disabled &&
      repository.size > 0 &&
      repository.name.toLowerCase() !== USERNAME.toLowerCase(),
  );

  const languageBytes = {};
  for (const repository of sourceRepositories) {
    const { data: languages } = await githubRequest(
      `/repos/${encodeURIComponent(USERNAME)}/${encodeURIComponent(
        repository.name,
      )}/languages`,
    );

    if (
      !languages ||
      typeof languages !== "object" ||
      Array.isArray(languages)
    ) {
      continue;
    }

    for (const [language, bytes] of Object.entries(languages)) {
      if (Number.isFinite(bytes) && bytes > 0) {
        languageBytes[language] = (languageBytes[language] || 0) + bytes;
      }
    }
  }

  return {
    publicRepositories: Number(user.public_repos) || repositories.length,
    sourceRepositories: sourceRepositories.length,
    stars: sourceRepositories.reduce(
      (sum, repository) => sum + (repository.stargazers_count || 0),
      0,
    ),
    forks: sourceRepositories.reduce(
      (sum, repository) => sum + (repository.forks_count || 0),
      0,
    ),
    languages: calculateLanguageShares(languageBytes),
  };
}

async function main() {
  const stats = await collectStats();
  const svg = renderSvg(stats);
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });

  const currentSvg = fs.existsSync(OUTPUT_PATH)
    ? fs.readFileSync(OUTPUT_PATH, "utf8")
    : null;

  if (currentSvg === svg) {
    console.log("Repository statistics are already up to date.");
    return;
  }

  fs.writeFileSync(OUTPUT_PATH, svg, "utf8");
  console.log(
    `Updated ${path.relative(process.cwd(), OUTPUT_PATH)}: ` +
      `${stats.publicRepositories} public repos, ` +
      `${stats.sourceRepositories} source projects, ` +
      `${stats.languages.length} language groups.`,
  );
}

main().catch((error) => {
  console.error(`Unable to generate repository statistics: ${error.message}`);
  process.exitCode = 1;
});
