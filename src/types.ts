/**
 * Local type definitions mirroring the subset of @coasys/ad4m-ldk types
 * needed by the Hypercore Link Language.
 *
 * Kept local so that pure modules can be imported and tested without
 * pulling in the ad4m:host runtime.
 */

export type DID = string;
export type Address = string;

export interface ExpressionProof {
    signature: string;
    key: string;
    valid?: boolean;
    invalid?: boolean;
}

export interface Expression<T = unknown> {
    author: DID;
    timestamp: string;
    data: T;
    proof: ExpressionProof;
}

export interface Link {
    source: string;
    target: string;
    predicate?: string;
}

export interface LinkExpression extends Expression<Link> {
    status?: string;
}

export interface PerspectiveDiff {
    additions: LinkExpression[];
    removals: LinkExpression[];
}

export interface Perspective {
    links: LinkExpression[];
}
