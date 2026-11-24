// Copyright (c) Dimsi. Licensed under the MIT License.

import fs = require('fs');

/**
 * Reads the `selectedConnection` of an `xrmFramework.config`.
 *
 * Only that one attribute of the root element is needed, so the file is not handed to an XML
 * parser: the attributes of a single known start tag are tokenised instead, which is exact for
 * this shape and brings no dependency. Anything more - entities, namespaces, nested elements - is
 * not something this file ever contains.
 */
export function readSelectedConnection(configPath: string): string {
    const content = fs.readFileSync(configPath, 'utf8');

    const start = content.indexOf('<xrmFramework');

    if (start < 0) {
        throw new Error(`${configPath} has no <xrmFramework> element.`);
    }

    const end = content.indexOf('>', start);

    if (end < 0) {
        throw new Error(`${configPath} has an unterminated <xrmFramework> element.`);
    }

    const selected = attribute(content.substring(start, end), 'selectedConnection');

    if (!selected) {
        throw new Error(
            `${configPath} declares no selectedConnection, so there is no connection to write.`);
    }

    return selected;
}

/** The value of one attribute of a start tag, single or double quoted. */
function attribute(tag: string, name: string): string | undefined {
    const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag);

    if (!match) return undefined;

    const value = match[2] !== undefined ? match[2] : match[3];

    return value && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Escapes a value for an XML attribute written between double quotes.
 *
 * A client secret is base64-ish and routinely contains `&`, `<` and `+`; one that contains a quote
 * used to produce a `connectionStrings.config` that no longer parsed, which is a confusing way to
 * learn that your secret was fine.
 */
export function escapeAttribute(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
