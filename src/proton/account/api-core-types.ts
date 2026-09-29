/**
 * Hand-trimmed stand-in for the OpenAPI-generated `api-core-types.ts` that
 * ships in `incubating/account/js` of the Proton Drive SDK repository.
 *
 * The generated file is ~26k lines describing the whole Proton core API. The
 * vendored account module only ever indexes into the handful of operations
 * below, so only those are reproduced here — with only the fields the module
 * actually reads. The nesting mirrors the generated `paths` shape exactly so
 * that `accountApi.ts` and `addresses.ts` stay byte-identical to upstream and
 * can be re-vendored without edits.
 *
 * See VENDORED.md for the provenance of this directory.
 */

type JsonResponse<T> = { responses: { 200: { content: { 'application/json': T } } } };

export interface components {
    schemas: {
        AddressKey: {
            ID: string;
            Version: number;
            /** @deprecated Do not rely on public keys returned from the API. */
            PublicKey: string;
            PrivateKey?: string | null;
            /** Token that decrypts this address key via the user key, on migrated accounts. */
            Token?: string | null;
            /** Present only on migrated keys; used to verify {@link AddressKey.Token}. */
            Signature?: string | null;
            Primary: number;
            Active: number;
        };
        AddressUser: {
            ID: string;
            Email: string;
            Status: number;
            Type: number;
            Order: number;
            Keys?: components['schemas']['AddressKey'][] | null;
        };
    };
}

/**
 * `/core/v4/auth/info` answers with a two-branch union: an SSO challenge, or
 * the SRP material. `accountApi.info` narrows to the SRP branch by testing for
 * `Modulus`, which relies on the branches having no property in common — keep
 * it that way if you widen either of them.
 */
type AuthInfoResponse =
    | { SSOChallengeToken?: string }
    | {
          Code?: number;
          Modulus?: string;
          ServerEphemeral?: string;
          Version?: number;
          Salt?: string;
          SRPSession?: string;
          Username?: string;
          '2FA'?: { Enabled?: number; FIDO2?: Record<string, unknown> };
      };

export interface paths {
    '/core/{_version}/auth': {
        post: JsonResponse<{
            Code?: number;
            UID?: string;
            AccessToken?: string;
            RefreshToken?: string;
            ServerProof?: string;
            Scope?: string;
            '2FA'?: { Enabled?: number } | null;
        }>;
    };
    '/core/{_version}/auth/info': {
        post: JsonResponse<AuthInfoResponse>;
    };
    '/core/{_version}/auth/modulus': {
        get: JsonResponse<{ Code?: number; Modulus?: string; ModulusID?: string }>;
    };
    '/core/{_version}/settings': {
        get: JsonResponse<{ Code?: number; UserSettings?: { Telemetry?: number } | null }>;
    };
    '/core/{_version}/users': {
        get: JsonResponse<{
            Code?: number;
            User?: {
                ID?: string;
                Name?: string | null;
                Keys?: { ID?: string; PrivateKey?: string; Primary?: number; Active?: number }[] | null;
            } | null;
        }>;
    };
    '/core/{_version}/addresses': {
        get: JsonResponse<{
            Code?: number;
            Total?: number;
            Addresses?: components['schemas']['AddressUser'][] | null;
        }>;
    };
    '/core/{_version}/keys/salts': {
        get: JsonResponse<{ Code?: number; KeySalts?: { ID?: string; KeySalt?: string | null }[] | null }>;
    };
    '/core/{_version}/keys/all': {
        get: JsonResponse<{
            Code?: number;
            Address?: { Keys?: { PublicKey: string; Flags?: number; Primary?: number }[] | null } | null;
        }>;
    };
}
