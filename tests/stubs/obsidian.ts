/**
 * Stub for the `obsidian` module, which only exists inside the app.
 *
 * `scripts/test.mjs` aliases the real module to this one so the units that
 * merely import a type or a single function from Obsidian stay testable. It
 * deliberately implements almost nothing: anything that needs real Obsidian
 * behaviour belongs in manual testing against a scratch vault, not here.
 */

export type RequestUrlParam = {
    url: string;
    method?: string;
    contentType?: string;
    body?: string | ArrayBuffer;
    headers?: Record<string, string>;
    throw?: boolean;
};

export type RequestUrlResponse = {
    status: number;
    headers: Record<string, string>;
    arrayBuffer: ArrayBuffer;
    json: unknown;
    text: string;
};

/** Replaced per-test via {@link setRequestUrlHandler}. */
let handler: (param: RequestUrlParam) => Promise<RequestUrlResponse> = () => {
    throw new Error('requestUrl was called without a handler set');
};

export function setRequestUrlHandler(next: typeof handler): void {
    handler = next;
}

export function requestUrl(param: RequestUrlParam | string): Promise<RequestUrlResponse> {
    return handler(typeof param === 'string' ? { url: param } : param);
}

export class Plugin {}
export class PluginSettingTab {}
export class Modal {}
export class Notice {}
export class Setting {}
export class TFile {}
export class TFolder {}
export class TAbstractFile {}
export function setIcon(): void {}
export function setTooltip(): void {}
