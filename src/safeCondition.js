'use strict';

/**
 * A deliberately small, non-executable Python-like condition interpreter.
 * The debugger must NEVER compile conditions or device-provided repr() output
 * with eval, Function, vm, a shell, or any other host execution mechanism.
 *
 * Unsupported syntax causes a parse error so the debugger pauses (fail safe).
 */

const MAX_EXPRESSION_LENGTH = 1024;
const MAX_TOKENS = 256;
const MAX_DEPTH = 32;

function parseDeviceLiteral(value) {
    if (typeof value !== 'string') return value;
    const source = value.trim().slice(0, 8192);
    if (source === 'None' || source === 'null') return null;
    if (source === 'True' || source === 'true') return true;
    if (source === 'False' || source === 'false') return false;
    if (/^[+-]?0x[0-9a-f]+$/i.test(source)) return Number(source);
    if (/^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)$/.test(source)) {
        const number = Number(source);
        return Number.isFinite(number) ? number : source;
    }
    if (source.length >= 2 && source[0] === '"' && source.at(-1) === '"') {
        try {
            const parsed = JSON.parse(source);
            return typeof parsed === 'string' ? parsed : source;
        } catch (_) { return source; }
    }
    if (source.length >= 2 && source[0] === "'" && source.at(-1) === "'") {
        const body = source.slice(1, -1);
        // Only a conservative, explicit subset of Python repr escapes is
        // accepted. Never interpret code or unknown escape forms.
        let decoded = '';
        for (let i = 0; i < body.length; i++) {
            const c = body[i];
            if (c !== '\\') {
                decoded += c;
                continue;
            }
            const next = body[++i];
            if (next === undefined) return source;
            const escapes = { n: '\n', r: '\r', t: '\t', '\\': '\\', "'": "'", '"': '"' };
            if (!Object.prototype.hasOwnProperty.call(escapes, next)) return source;
            decoded += escapes[next];
        }
        return decoded;
    }
    return source;
}

function tokenize(input) {
    if (typeof input !== 'string' || !input.trim() ||
        input.length > MAX_EXPRESSION_LENGTH) throw new Error('Invalid condition length');
    const tokens = [];
    let pos = 0;
    while (pos < input.length) {
        if (/\s/.test(input[pos])) { pos++; continue; }
        const fragment = input.slice(pos);
        let match;
        if (fragment[0] === '"' || fragment[0] === "'") {
            const quote = fragment[0];
            let i = 1;
            while (i < fragment.length) {
                if (fragment[i] === '\\') { i += 2; continue; }
                if (fragment[i] === quote) break;
                i++;
            }
            if (i >= fragment.length) throw new Error('Unterminated string');
            const raw = fragment.slice(0, i + 1);
            tokens.push({ type: 'literal', value: parseDeviceLiteral(raw) });
            pos += i + 1;
        } else if ((match = /^(?:0x[0-9a-f]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/i.exec(fragment))) {
            tokens.push({ type: 'literal', value: Number(match[0]) });
            pos += match[0].length;
        } else if ((match = /^[A-Za-z_][A-Za-z_0-9]*/.exec(fragment))) {
            const word = match[0];
            if (word === 'True' || word === 'False' || word === 'None') {
                tokens.push({ type: 'literal', value: parseDeviceLiteral(word) });
            } else {
                tokens.push({ type: 'word', value: word });
            }
            pos += word.length;
        } else if ((match = /^(?:==|!=|<=|>=|\*\*|\/\/|[()+\-*\/%<>])/.exec(fragment))) {
            tokens.push({ type: 'symbol', value: match[0] });
            pos += match[0].length;
        } else {
            throw new Error('Unsupported character in condition');
        }
        if (tokens.length > MAX_TOKENS) throw new Error('Condition has too many tokens');
    }
    tokens.push({ type: 'end', value: '' });
    return tokens;
}

function compileCondition(input) {
    const tokens = tokenize(input);
    let index = 0;
    let depth = 0;
    const peek = () => tokens[index].value;
    const consume = value => {
        if (peek() === value) { index++; return true; }
        return false;
    };
    const node = (op, ...args) => ({ op, args });
    const nested = fn => {
        if (++depth > MAX_DEPTH) throw new Error('Condition nesting too deep');
        try { return fn(); } finally { depth--; }
    };
    function atom() {
        const item = tokens[index];
        if (consume('(')) {
            const expression = nested(orExpression);
            if (!consume(')')) throw new Error('Missing closing parenthesis');
            return expression;
        }
        if (item.type === 'literal') { index++; return node('value', item.value); }
        if (item.type === 'word' && !['and', 'or', 'not', 'in'].includes(item.value)) {
            index++;
            return node('identifier', item.value);
        }
        throw new Error('Expected value or variable');
    }
    function unary() {
        if (consume('not')) return node('not', nested(unary));
        if (consume('+')) return node('positive', nested(unary));
        if (consume('-')) return node('negative', nested(unary));
        return atom();
    }
    function power() {
        let left = unary();
        if (consume('**')) left = node('**', left, nested(power));
        return left;
    }
    function product() {
        let left = power();
        while (['*', '/', '//', '%'].includes(peek())) {
            const op = tokens[index++].value;
            left = node(op, left, power());
        }
        return left;
    }
    function sum() {
        let left = product();
        while (['+', '-'].includes(peek())) {
            const op = tokens[index++].value;
            left = node(op, left, product());
        }
        return left;
    }
    function comparison() {
        let left = sum();
        while (['==', '!=', '<', '<=', '>', '>=', 'in', 'is'].includes(peek()) ||
            (peek() === 'not' && tokens[index + 1]?.value === 'in')) {
            let op = tokens[index++].value;
            if (op === 'not' && peek() === 'in') { index++; op = 'not in'; }
            if (op === 'is' && consume('not')) op = 'is not';
            left = node(op, left, sum());
        }
        return left;
    }
    function andExpression() {
        let left = comparison();
        while (consume('and')) left = node('and', left, comparison());
        return left;
    }
    function orExpression() {
        let left = andExpression();
        while (consume('or')) left = node('or', left, andExpression());
        return left;
    }
    const ast = orExpression();
    if (tokens[index].type !== 'end') throw new Error('Unsupported condition syntax');
    return ast;
}

function isTruthy(value) {
    if (value === null || value === undefined || value === false || value === 0 || value === '') return false;
    return !(Array.isArray(value) && value.length === 0);
}

function evaluateCondition(expression, variables = {}) {
    const ast = compileCondition(expression);
    function evaluate(tree) {
        const [left, right] = tree.args;
        switch (tree.op) {
        case 'value': return left;
        case 'identifier':
            if (!Object.prototype.hasOwnProperty.call(variables, left)) {
                throw new Error('Variable not available: ' + left);
            }
            return variables[left];
        case 'not': return !isTruthy(evaluate(left));
        case 'positive': return +number(evaluate(left));
        case 'negative': return -number(evaluate(left));
        case 'and': { const v = evaluate(left); return isTruthy(v) ? evaluate(right) : v; }
        case 'or': { const v = evaluate(left); return isTruthy(v) ? v : evaluate(right); }
        default: break;
        }
        const a = evaluate(left);
        const b = evaluate(right);
        switch (tree.op) {
        case '+': return typeof a === 'string' && typeof b === 'string' ? a + b : number(a) + number(b);
        case '-': return number(a) - number(b);
        case '*': return number(a) * number(b);
        case '/': return number(a) / number(b);
        case '//': return Math.floor(number(a) / number(b));
        case '%': return ((number(a) % number(b)) + number(b)) % number(b);
        case '**': return safePower(number(a), number(b));
        case '==':
        case 'is': return a === b;
        case '!=':
        case 'is not': return a !== b;
        case '<': return a < b;
        case '<=': return a <= b;
        case '>': return a > b;
        case '>=': return a >= b;
        case 'in': return membership(a, b);
        case 'not in': return !membership(a, b);
        default: throw new Error('Unsupported operator');
        }
    }
    function number(value) {
        if (typeof value === 'boolean') return value ? 1 : 0;
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw new Error('Arithmetic requires finite numeric values');
        }
        return value;
    }
    function safePower(a, b) {
        if (Math.abs(b) > 1024) throw new Error('Exponent too large');
        return a ** b;
    }
    function membership(a, b) {
        if (typeof b === 'string') return b.includes(String(a));
        if (Array.isArray(b)) return b.includes(a);
        throw new Error('Membership requires string or array');
    }
    return isTruthy(evaluate(ast));
}

module.exports = { parseDeviceLiteral, compileCondition, evaluateCondition };
