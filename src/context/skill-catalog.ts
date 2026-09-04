import path from "node:path";
import type { SkillMetadata } from "./skill-registry.js";

export const MAX_SKILL_CATALOG_CHARS = 8_000;
const SHORT_DESCRIPTION_CHARS = 160;

export interface SkillCatalog {
  content: string;
  includedSkills: number;
  omittedSkills: number;
  shortenedDescriptions: number;
  warning?: string;
}

const CATALOG_HEADER = `Skills use progressive disclosure. Match the user's task against each description, then read the selected SKILL.md before acting. Resolve relative references from the directory containing SKILL.md.

<available_skills>`;
const CATALOG_FOOTER = "</available_skills>";

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/\r/g, "&#13;")
    .replace(/\n/g, "&#10;");
}

function normalizeDescription(description: string): string {
  return description.replace(/\s+/g, " ").trim();
}

function shortenDescription(description: string): string {
  const normalized = normalizeDescription(description);
  if (normalized.length <= SHORT_DESCRIPTION_CHARS) return normalized;
  return `${normalized.slice(0, SHORT_DESCRIPTION_CHARS - 1).trimEnd()}…`;
}

function formatSkill(skill: SkillMetadata, description: string): string {
  return `<skill name="${escapeXmlAttribute(skill.name)}" description="${escapeXmlAttribute(description)}" location="${escapeXmlAttribute(path.resolve(skill.filePath))}" />`;
}

function renderCatalog(entries: string[]): string {
  return `${CATALOG_HEADER}\n${entries.join("\n")}\n${CATALOG_FOOTER}`;
}

/** Inline skill metadata within a bounded prompt; full SKILL.md bodies remain on demand. */
export function createSkillCatalog(skills: SkillMetadata[]): SkillCatalog {
  if (skills.length === 0) {
    return { content: "", includedSkills: 0, omittedSkills: 0, shortenedDescriptions: 0 };
  }

  const descriptions = skills.map((skill) => normalizeDescription(skill.description));
  let entries = skills.map((skill, index) => formatSkill(skill, descriptions[index]!));
  let content = renderCatalog(entries);
  if (content.length <= MAX_SKILL_CATALOG_CHARS) {
    return {
      content,
      includedSkills: skills.length,
      omittedSkills: 0,
      shortenedDescriptions: 0,
    };
  }

  const shortened = descriptions.map(shortenDescription);
  const shortenedDescriptions = shortened.filter((description, index) => (
    description !== descriptions[index]
  )).length;
  entries = skills.map((skill, index) => formatSkill(skill, shortened[index]!));
  content = renderCatalog(entries);
  if (content.length <= MAX_SKILL_CATALOG_CHARS) {
    return {
      content,
      includedSkills: skills.length,
      omittedSkills: 0,
      shortenedDescriptions,
    };
  }

  const includedEntries: string[] = [];
  for (const entry of entries) {
    if (renderCatalog([...includedEntries, entry]).length > MAX_SKILL_CATALOG_CHARS) break;
    includedEntries.push(entry);
  }
  const omittedSkills = skills.length - includedEntries.length;
  return {
    content: includedEntries.length > 0 ? renderCatalog(includedEntries) : "",
    includedSkills: includedEntries.length,
    omittedSkills,
    shortenedDescriptions,
    warning: `${omittedSkills} skill(s) omitted from model context because the skill catalog exceeds ${MAX_SKILL_CATALOG_CHARS} characters.`,
  };
}
