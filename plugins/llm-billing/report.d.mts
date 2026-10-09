export declare const REPORT_VERSION: 1
export declare function reportLine(report: unknown): string
export declare function encodeReport(report: unknown): string
export declare function decodeReport(text: string | undefined): unknown
export declare const TOKEN_CURRENCY: 'TOK'
export declare function tokenAmount(value: string | number): string
export declare function exactTokens(value: string | number): string
