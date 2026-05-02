/**
 * Signing adapter interface — interfaces and singleton only.
 *
 * No ad4m:host imports. Safe for cross-runtime testing.
 *
 * Both AD4M and Hypercore use Ed25519. The signing adapter wraps
 * AD4M's agent signing for use in commit block authentication.
 */

export interface SigningAdapter {
    /** Sign a string payload and return the hex-encoded signature. */
    signStringHex(payload: string): string;
    /** Return the signing key ID. */
    signingKeyId(): string;
}

let _signing: SigningAdapter | null = null;

export function initSigning(adapter: SigningAdapter): void {
    _signing = adapter;
}

export function getSigning(): SigningAdapter {
    if (!_signing) {
        throw new Error(
            "SigningAdapter not initialized. Call initSigning() during language init().",
        );
    }
    return _signing;
}
