// Types for translate.mjs (used by the test adapter in worker/db/pgshim).
export interface Token { t: string; v?: unknown; quoted?: boolean; items?: Token[][] }
export class Untranslatable extends Error {}
export function tokenize(src: string): Token[]
export function render(tokens: Token[], opts?: { bare?: boolean }): string
export function rewrite(tokens: Token[], opts?: { context?: boolean; functions?: Set<string>; bare?: boolean }): Token[]
export function match(tokens: Token[], open: number): number
export function operandStart(tokens: Token[], end: number): number
export function readType(tokens: Token[], i: number): { name: string; array: boolean; end: number }
export function splitTop(tokens: Token[]): Token[][]
export function toSqlite(expr: string, opts?: { context?: boolean; functions?: Set<string>; bare?: boolean }): string
export function pgArrayToJson(text: string, elemType: string): string
export const NOW: string
export const UUID: string
