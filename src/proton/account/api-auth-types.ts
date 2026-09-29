/**
 * Hand-trimmed stand-in for the OpenAPI-generated `api-auth-types.ts` that
 * ships in `incubating/account/js` of the Proton Drive SDK repository. See the
 * sibling `api-core-types.ts` for why this file exists and VENDORED.md for the
 * provenance of this directory.
 */

type JsonResponse<T> = { responses: { 200: { content: { 'application/json': T } } } };

export interface paths {
    '/auth/{_version}/refresh': {
        post: JsonResponse<{
            Code?: number;
            UID?: string;
            AccessToken?: string;
            RefreshToken?: string;
            Scope?: string;
        }>;
    };
    '/auth/{_version}/sessions': {
        post: JsonResponse<{
            Code?: number;
            UID?: string;
            AccessToken?: string;
            RefreshToken?: string;
            Scopes?: string[];
        }>;
    };
}
