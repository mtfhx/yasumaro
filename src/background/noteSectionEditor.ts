// src/background/noteSectionEditor.ts
import { getUserLocale } from '../utils/localeUtils.js';
import type { ObsidianSectionOrder } from '../utils/storage/types.js';

export interface InsertOptions {
  /**
   * PBI 2026-09-25-13: when true, skip insertion when the target section
   * already contains an identical content block. Only the offline replay path
   * sets this — the retry of one operation must not stack a second copy.
   * Dashboard append (user-invoked) keeps unconditional insertion.
   */
  dedupe?: boolean;
  /**
   * 挿入位置。'newest_first' はセクション先頭（最新が上）、
   * 'oldest_first' はセクション末尾への追記（従来動作）。
   * 省略時は 'newest_first'。
   */
  order?: ObsidianSectionOrder;
}

/**
 * 表示言語ごとの既定見出し。
 *
 * ノート側の見出しは拡張機能の UI 文言ではなく「既存ノートを検出するための
 * 安定した文字列」なので、i18n メッセージではなく固定値で持つ。既存ノートが
 * 別言語の見出しのままでも、それを見つけて同じセクションへ追記できるように
 * するため、過去に既定として使った見出しも含めて保持する。
 */
const JA_SECTION_HEADER = '# 🌐 ブラウザ閲覧履歴';
const ZH_SECTION_HEADER = '# 🌐 浏览器访问记录';
const EN_SECTION_HEADER = '# 🌐 Browser History';

/** 既存ノート検出に使う既知の見出し（設定より優先して再利用する）。 */
const KNOWN_SECTION_HEADERS: readonly string[] = [
  JA_SECTION_HEADER,
  ZH_SECTION_HEADER,
  EN_SECTION_HEADER,
];

export class NoteSectionEditor {
  /** 後方互換のための既定見出し（日本語）。 */
  static DEFAULT_SECTION_HEADER = JA_SECTION_HEADER;

  /**
   * ロケールに応じた既定見出しを返す。
   *
   * @param uiLocale - 表示言語（例: 'ja-JP'）。省略時は chrome.i18n から取得。
   */
  static defaultSectionHeader(uiLocale?: string): string {
    const locale = (uiLocale ?? getUserLocale()).toLowerCase();
    if (locale.startsWith('zh')) return ZH_SECTION_HEADER;
    if (locale.startsWith('ja')) return JA_SECTION_HEADER;
    return EN_SECTION_HEADER;
  }

  /**
   * 見出しとして使える1行に正規化する。
   * 設定値に改行が混ざっていても、先頭行だけを見出しとして扱う。
   */
  static normalizeSectionHeader(header: string | null | undefined): string {
    const trimmed = (header ?? '').trim();
    if (!trimmed) return '';
    return trimmed.split(/\r?\n/)[0]?.trim() ?? '';
  }

  /**
   * 実際に使う見出しを決める。
   *
   * 優先順位:
   * 1. ノート内に既にある見出し（設定値 → 表示言語の既定 → 既知の見出し）
   *    — 同じノートに別の履歴セクションを増やさないため
   * 2. 設定値
   * 3. 表示言語の既定見出し（zh / ja / en）
   *
   * @param existingContent - 既存ノートの内容
   * @param configuredHeader - ユーザー設定の見出し（空なら自動）
   * @param uiLocale - 表示言語（テスト用。省略時は chrome.i18n）
   */
  static resolveSectionHeader(
    existingContent: string,
    configuredHeader: string | null | undefined = '',
    uiLocale?: string
  ): string {
    const configured = this.normalizeSectionHeader(configuredHeader);
    const localeDefault = this.defaultSectionHeader(uiLocale);

    const candidates = [configured, localeDefault, ...KNOWN_SECTION_HEADERS].filter(
      (header): header is string => header.length > 0
    );

    const existing = candidates.find(header => this._hasHeaderLine(existingContent, header));
    if (existing) return existing;

    return configured || localeDefault;
  }

  static insertIntoSection(
    existingContent: string,
    sectionHeader: string,
    newContent: string,
    options: InsertOptions = {}
  ): string {
    if (this._hasHeaderLine(existingContent, sectionHeader)) {
      return this._insertUnderExistingSection(existingContent, sectionHeader, newContent, options);
    } else {
      return this._createNewSection(existingContent, sectionHeader, newContent);
    }
  }

  /** 内容中に、その見出しと完全一致する行があるか。 */
  private static _hasHeaderLine(content: string, sectionHeader: string): boolean {
    return content.split('\n').some(line => line.trim() === sectionHeader);
  }

  private static _insertUnderExistingSection(
    content: string,
    sectionHeader: string,
    newContent: string,
    options: InsertOptions = {}
  ): string {
    const lines = content.split('\n');
    const sectionIndex = lines.findIndex(line => line.trim() === sectionHeader);

    if (options.dedupe && this._sectionContains(lines, sectionIndex, newContent)) {
      // Same operation replayed: the identical block is already in the
      // section, so inserting again would stack a duplicate.
      return content;
    }

    const order = options.order ?? 'newest_first';
    if (order === 'newest_first') {
      // 見出し直後の空行は区切りとして残し、その下に最新の記録を挿入する。
      let topIndex = sectionIndex + 1;
      while (topIndex < lines.length && lines[topIndex]?.trim() === '') {
        topIndex++;
      }
      lines.splice(topIndex, 0, newContent);
      return lines.join('\n');
    }

    // Start at the line after the section header
    let insertIndex = sectionIndex + 1;

    // Find the next section header (any line starting with #)
    for (let i = sectionIndex + 1; i < lines.length; i++) {
      if (lines[i]?.startsWith('#')) {
        insertIndex = i;
        break;
      }
      insertIndex = i + 1;
    }

    lines.splice(insertIndex, 0, newContent);
    return lines.join('\n');
  }

  /**
   * Whether the section starting at `sectionIndex` already contains the exact
   * `newContent` block. The section runs until the next heading line; match is
   * by contiguous line sequence, so a partial or reordered match does not
   * count.
   */
  private static _sectionContains(lines: string[], sectionIndex: number, newContent: string): boolean {
    const block = newContent.split('\n');
    const end = lines.findIndex((line, i) => i > sectionIndex && line.startsWith('#'));
    const sectionEnd = end === -1 ? lines.length : end;

    for (let i = sectionIndex + 1; i + block.length <= sectionEnd; i++) {
      let matched = true;
      for (let j = 0; j < block.length; j++) {
        if (lines[i + j] !== block[j]) {
          matched = false;
          break;
        }
      }
      if (matched) {
        return true;
      }
    }
    return false;
  }

  private static _createNewSection(existingContent: string, sectionHeader: string, newContent: string): string {
    let content = existingContent;
    if (content && !content.endsWith('\n')) {
      content += '\n';
    }
    return content + `${sectionHeader}\n${newContent}\n`;
  }
}
