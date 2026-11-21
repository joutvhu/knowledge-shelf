/**
 * Relevance scoring, filtering, and optional content snippet search.
 */

import { DocEntry, getSearchExtras } from './index-cache.js';

export interface SearchOptions {
  type?: string;
  tags?: string[];
  unit?: string;
  includeContent?: boolean;
}

export interface SearchResultEntry extends DocEntry {
  relevance_score: number;
  matched_sections?: string[];
  matched_references?: Array<{ key: string; file: string; matched_sections?: string[] }>;
  content_snippets?: string[];
}

function foldDiacritics(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function matchesToken(haystackLower: string, termLower: string): boolean {
  const escaped = termLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(haystackLower);
}

function scoreField(haystackLower: string, termLower: string, fullWeight: number): number {
  if (!haystackLower) return 0;

  if (haystackLower.includes(termLower)) {
    if (matchesToken(haystackLower, termLower)) return fullWeight;
    if (termLower.length <= 2) return 0;
    return Math.max(1, Math.floor(fullWeight / 2));
  }

  // Fallback: diacritic-folded comparison (useful for Vietnamese / accented docs)
  const foldedHaystack = foldDiacritics(haystackLower);
  const foldedTerm = foldDiacritics(termLower);
  if (foldedTerm && foldedHaystack.includes(foldedTerm)) {
    if (matchesToken(foldedHaystack, foldedTerm)) return Math.max(1, Math.floor(fullWeight * 0.8));
    if (foldedTerm.length <= 2) return 0;
    return Math.max(1, Math.floor(fullWeight * 0.4));
  }

  return 0;
}

export function searchScore(doc: DocEntry, queryTerms: string[]): number {
  let score = 0;
  const titleLower = (doc.title || '').toLowerCase();
  const descLower = (doc.description || '').toLowerCase();
  const tagsLower = (doc.tags || []).join(' ').toLowerCase();
  const aliasesLower = (doc.aliases || []).join(' ').toLowerCase();
  const nameLower = (doc.name || '').toLowerCase();
  const sectionsLower = (doc.sections || []).join(' ').toLowerCase();
  const modulesLower = (doc.modules || []).join(' ').toLowerCase();
  const typeLower = (doc.type || '').toLowerCase();
  const extras = getSearchExtras(doc);

  for (const term of queryTerms) {
    const t = term.toLowerCase();
    if (!t) continue;
    score += scoreField(aliasesLower, t, 12);
    score += scoreField(titleLower, t, 10);
    score += scoreField(tagsLower, t, 8);
    score += scoreField(typeLower, t, 7);
    score += scoreField(modulesLower, t, 6);
    score += scoreField(nameLower, t, 6);
    score += scoreField(sectionsLower, t, 4);
    score += scoreField(descLower, t, 2);
    if (extras) {
      score += scoreField(extras.moduleTags, t, 6);
      score += scoreField(extras.capabilityKeys, t, 5);
      score += scoreField(extras.appliesToText, t, 5);
      score += scoreField(extras.referenceTags, t, 5);
      score += scoreField(extras.referenceSections.join(' ').toLowerCase(), t, 4);
      score += scoreField(extras.capabilityDescriptions, t, 2);
    }
  }

  if (score > 0 && doc.status === 'deprecated') {
    score = Math.max(1, Math.floor(score * 0.4));
  }

  return score;
}

function extractBodySnippets(body: string, terms: string[], maxSnippets = 2): string[] {
  if (!body) return [];
  const lines = body.split(/\r?\n/);
  const snippets: string[] = [];
  for (let i = 0; i < lines.length && snippets.length < maxSnippets; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const lower = foldDiacritics(line.toLowerCase());
    if (terms.some((t) => lower.includes(foldDiacritics(t.toLowerCase())))) {
      snippets.push(line.length > 160 ? line.slice(0, 157) + '...' : line);
    }
  }
  return snippets;
}

export function rankDocuments(
  docs: DocEntry[],
  query: string,
  options: SearchOptions = {}
): SearchResultEntry[] {
  const queryTerms = query.trim().split(/\s+/).filter(Boolean);
  if (queryTerms.length === 0) return [];

  const filterType = options.type?.toLowerCase().trim();
  const filterTags = options.tags?.map((t) => t.toLowerCase().trim()).filter(Boolean) || [];
  const filterUnit = options.unit?.toLowerCase().trim();

  const scored: SearchResultEntry[] = [];

  for (const doc of docs) {
    if (filterType) {
      const docType = doc.has_manifest ? (doc.type || '').toLowerCase() : 'standalone';
      if (docType !== filterType) continue;
    }

    if (filterUnit) {
      const nameMatch = doc.name.toLowerCase() === filterUnit || doc.title.toLowerCase() === filterUnit;
      if (!nameMatch) continue;
    }

    if (filterTags.length > 0) {
      const docTagSet = new Set((doc.tags || []).map((t) => t.toLowerCase()));
      const extras = getSearchExtras(doc);
      if (extras?.moduleTags) {
        for (const mt of extras.moduleTags.split(/\s+/)) {
          if (mt) docTagSet.add(mt);
        }
      }
      if (!filterTags.every((t) => docTagSet.has(t))) continue;
    }

    let score = searchScore(doc, queryTerms);
    const extras = getSearchExtras(doc);
    const contentSnippets: string[] = [];

    if (options.includeContent && extras) {
      let bodyHits = 0;
      const bodyLower = foldDiacritics(extras.docBody.toLowerCase());
      for (const term of queryTerms) {
        const ft = foldDiacritics(term.toLowerCase());
        if (ft && bodyLower.includes(ft)) bodyHits++;
      }
      if (bodyHits > 0) {
        score += bodyHits * 2;
        contentSnippets.push(...extractBodySnippets(extras.docBody, queryTerms, 2));
      }
      for (const ref of extras.references) {
        const refLower = foldDiacritics(ref.body.toLowerCase());
        if (queryTerms.some((term) => refLower.includes(foldDiacritics(term.toLowerCase())))) {
          score += 1;
          if (contentSnippets.length < 3) {
            contentSnippets.push(...extractBodySnippets(ref.body, queryTerms, 1));
          }
        }
      }
    }

    if (score <= 0) continue;

    const entry: SearchResultEntry = { ...doc, relevance_score: score };

    if (doc.sections && doc.sections.length > 0) {
      const matchedSections = doc.sections.filter((sec) =>
        queryTerms.some((term) => scoreField(sec.toLowerCase(), term.toLowerCase(), 1) > 0)
      );
      if (matchedSections.length > 0) {
        entry.matched_sections = matchedSections.slice(0, 5);
      }
    }

    if (extras && extras.references.length > 0) {
      const matchedRefs: Array<{ key: string; file: string; matched_sections?: string[] }> = [];
      for (const ref of extras.references) {
        const refText = `${ref.key} ${ref.description} ${ref.tags.join(' ')}`.toLowerCase();
        const refMetaMatch = queryTerms.some((t) => scoreField(refText, t.toLowerCase(), 1) > 0);
        const refSecMatches = ref.sections.filter((sec) =>
          queryTerms.some((t) => scoreField(sec.toLowerCase(), t.toLowerCase(), 1) > 0)
        );
        if (refMetaMatch || refSecMatches.length > 0) {
          matchedRefs.push({
            key: ref.key,
            file: ref.file,
            ...(refSecMatches.length > 0 ? { matched_sections: refSecMatches.slice(0, 4) } : {}),
          });
        }
      }
      if (matchedRefs.length > 0) {
        entry.matched_references = matchedRefs.slice(0, 5);
      }
    }

    if (contentSnippets.length > 0) {
      entry.content_snippets = contentSnippets;
    }

    scored.push(entry);
  }

  scored.sort((a, b) => b.relevance_score - a.relevance_score);
  return scored;
}
