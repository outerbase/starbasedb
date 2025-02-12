var it = Object.defineProperty
var st = (e, t, n) =>
    t in e
        ? it(e, t, { enumerable: !0, configurable: !0, writable: !0, value: n })
        : (e[t] = n)
var M = (e, t, n) => st(e, typeof t != 'symbol' ? t + '' : t, n)
var at = { Stringify: 1, BeforeStream: 2, Stream: 3 },
    T = (e, t) => {
        const n = new String(e)
        return (n.isEscaped = !0), (n.callbacks = t), n
    },
    lt = /[&<>'"]/,
    ot = async (e, t) => {
        let n = ''
        t || (t = [])
        const i = await Promise.all(e)
        for (let r = i.length - 1; (n += i[r]), r--, !(r < 0); r--) {
            let s = i[r]
            typeof s == 'object' && t.push(...(s.callbacks || []))
            const a = s.isEscaped
            if (
                ((s = await (typeof s == 'object' ? s.toString() : s)),
                typeof s == 'object' && t.push(...(s.callbacks || [])),
                s.isEscaped ?? a)
            )
                n += s
            else {
                const l = [n]
                j(s, l), (n = l[0])
            }
        }
        return T(n, t)
    },
    j = (e, t) => {
        const n = e.search(lt)
        if (n === -1) {
            t[0] += e
            return
        }
        let i,
            r,
            s = 0
        for (r = n; r < e.length; r++) {
            switch (e.charCodeAt(r)) {
                case 34:
                    i = '&quot;'
                    break
                case 39:
                    i = '&#39;'
                    break
                case 38:
                    i = '&amp;'
                    break
                case 60:
                    i = '&lt;'
                    break
                case 62:
                    i = '&gt;'
                    break
                default:
                    continue
            }
            ;(t[0] += e.substring(s, r) + i), (s = r + 1)
        }
        t[0] += e.substring(s, r)
    },
    ct = (e) => {
        const t = e.callbacks
        if (!(t != null && t.length)) return e
        const n = [e],
            i = {}
        return (
            t.forEach((r) => r({ phase: at.Stringify, buffer: n, context: i })),
            n[0]
        )
    },
    ie = Symbol('RENDERER'),
    he = Symbol('ERROR_HANDLER'),
    C = Symbol('STASH'),
    Ie = Symbol('INTERNAL'),
    ft = Symbol('MEMO'),
    ee = Symbol('PERMALINK'),
    Ae = (e) => ((e[Ie] = !0), e),
    Be =
        (e) =>
        ({ value: t, children: n }) => {
            if (!n) return
            const i = {
                children: [
                    {
                        tag: Ae(() => {
                            e.push(t)
                        }),
                        props: {},
                    },
                ],
            }
            Array.isArray(n)
                ? i.children.push(...n.flat())
                : i.children.push(n),
                i.children.push({
                    tag: Ae(() => {
                        e.pop()
                    }),
                    props: {},
                })
            const r = { tag: '', props: i, type: '' }
            return (
                (r[he] = (s) => {
                    throw (e.pop(), s)
                }),
                r
            )
        },
    Fe = (e) => {
        const t = [e],
            n = Be(t)
        return (n.values = t), (n.Provider = n), D.push(n), n
    },
    D = [],
    ut = (e) => {
        const t = [e],
            n = (i) => {
                t.push(i.value)
                let r
                try {
                    r = i.children
                        ? (Array.isArray(i.children)
                              ? new Ue('', {}, i.children)
                              : i.children
                          ).toString()
                        : ''
                } finally {
                    t.pop()
                }
                return r instanceof Promise
                    ? r.then((s) => T(s, s.callbacks))
                    : T(r)
            }
        return (n.values = t), (n.Provider = n), (n[ie] = Be(t)), D.push(n), n
    },
    I = (e) => e.values.at(-1),
    K = {
        title: [],
        script: ['src'],
        style: ['data-href'],
        link: ['href'],
        meta: ['name', 'httpEquiv', 'charset', 'itemProp'],
    },
    ye = {},
    V = 'data-precedence',
    q = (e) => (Array.isArray(e) ? e : [e]),
    $e = new WeakMap(),
    we =
        (e, t, n, i) =>
        ({ buffer: r, context: s }) => {
            if (!r) return
            const a = $e.get(s) || {}
            $e.set(s, a)
            const l = a[e] || (a[e] = [])
            let f = !1
            const y = K[e]
            if (y.length > 0) {
                e: for (const [, d] of l)
                    for (const u of y)
                        if (
                            ((d == null ? void 0 : d[u]) ?? null) ===
                            (n == null ? void 0 : n[u])
                        ) {
                            f = !0
                            break e
                        }
            }
            if (
                (f
                    ? (r[0] = r[0].replaceAll(t, ''))
                    : y.length > 0
                      ? l.push([t, n, i])
                      : l.unshift([t, n, i]),
                r[0].indexOf('</head>') !== -1)
            ) {
                let d
                if (i === void 0) d = l.map(([u]) => u)
                else {
                    const u = []
                    d = l
                        .map(([o, , c]) => {
                            let h = u.indexOf(c)
                            return (
                                h === -1 && (u.push(c), (h = u.length - 1)),
                                [o, h]
                            )
                        })
                        .sort((o, c) => o[1] - c[1])
                        .map(([o]) => o)
                }
                d.forEach((u) => {
                    r[0] = r[0].replaceAll(u, '')
                }),
                    (r[0] = r[0].replace(/(?=<\/head>)/, d.join('')))
            }
        },
    U = (e, t, n) => T(new $(e, n, q(t ?? [])).toString()),
    Z = (e, t, n, i) => {
        if ('itemProp' in n) return U(e, t, n)
        let { precedence: r, blocking: s, ...a } = n
        ;(r = i ? (r ?? '') : void 0), i && (a[V] = r)
        const l = new $(e, a, q(t || [])).toString()
        return l instanceof Promise
            ? l.then((f) => T(l, [...(f.callbacks || []), we(e, f, a, r)]))
            : T(l, [we(e, l, a, r)])
    },
    dt = ({ children: e, ...t }) => {
        const n = ge()
        if (n) {
            const i = I(n)
            if (i === 'svg' || i === 'head')
                return new $('title', t, q(e ?? []))
        }
        return Z('title', e, t, !1)
    },
    vt = ({ children: e, ...t }) => {
        const n = ge()
        return ['src', 'async'].some((i) => !t[i]) || (n && I(n) === 'head')
            ? U('script', e, t)
            : Z('script', e, t, !1)
    },
    ht = ({ children: e, ...t }) =>
        ['href', 'precedence'].every((n) => n in t)
            ? ((t['data-href'] = t.href), delete t.href, Z('style', e, t, !0))
            : U('style', e, t),
    yt = ({ children: e, ...t }) =>
        ['onLoad', 'onError'].some((n) => n in t) ||
        (t.rel === 'stylesheet' && (!('precedence' in t) || 'disabled' in t))
            ? U('link', e, t)
            : Z('link', e, t, 'precedence' in t),
    mt = ({ children: e, ...t }) => {
        const n = ge()
        return n && I(n) === 'head' ? U('meta', e, t) : Z('meta', e, t, !1)
    },
    He = (e, { children: t, ...n }) => new $(e, n, q(t ?? [])),
    pt = (e) => (
        typeof e.action == 'function' &&
            (e.action = ee in e.action ? e.action[ee] : void 0),
        He('form', e)
    ),
    We = (e, t) => (
        typeof t.formAction == 'function' &&
            (t.formAction = ee in t.formAction ? t.formAction[ee] : void 0),
        He(e, t)
    ),
    gt = (e) => We('input', e),
    St = (e) => We('button', e)
const ae = Object.freeze(
    Object.defineProperty(
        {
            __proto__: null,
            button: St,
            form: pt,
            input: gt,
            link: yt,
            meta: mt,
            script: vt,
            style: ht,
            title: dt,
        },
        Symbol.toStringTag,
        { value: 'Module' }
    )
)
var Et = new Map([
        ['className', 'class'],
        ['htmlFor', 'for'],
        ['crossOrigin', 'crossorigin'],
        ['httpEquiv', 'http-equiv'],
        ['itemProp', 'itemprop'],
        ['fetchPriority', 'fetchpriority'],
        ['noModule', 'nomodule'],
        ['formAction', 'formaction'],
    ]),
    te = (e) => Et.get(e) || e,
    qe = (e, t) => {
        for (const [n, i] of Object.entries(e)) {
            const r =
                n[0] === '-' || !/[A-Z]/.test(n)
                    ? n
                    : n.replace(/[A-Z]/g, (s) => `-${s.toLowerCase()}`)
            t(
                r,
                i == null
                    ? null
                    : typeof i == 'number'
                      ? r.match(
                            /^(?:a|border-im|column(?:-c|s)|flex(?:$|-[^b])|grid-(?:ar|[^a])|font-w|li|or|sca|st|ta|wido|z)|ty$/
                        )
                          ? `${i}`
                          : `${i}px`
                      : i
            )
        }
    },
    F = void 0,
    ge = () => F,
    Ct = (e) =>
        /[A-Z]/.test(e) &&
        e.match(
            /^(?:al|basel|clip(?:Path|Rule)$|co|do|fill|fl|fo|gl|let|lig|i|marker[EMS]|o|pai|pointe|sh|st[or]|text[^L]|tr|u|ve|w)/
        )
            ? e.replace(/([A-Z])/g, '-$1').toLowerCase()
            : e,
    bt = [
        'area',
        'base',
        'br',
        'col',
        'embed',
        'hr',
        'img',
        'input',
        'keygen',
        'link',
        'meta',
        'param',
        'source',
        'track',
        'wbr',
    ],
    kt = [
        'allowfullscreen',
        'async',
        'autofocus',
        'autoplay',
        'checked',
        'controls',
        'default',
        'defer',
        'disabled',
        'download',
        'formnovalidate',
        'hidden',
        'inert',
        'ismap',
        'itemscope',
        'loop',
        'multiple',
        'muted',
        'nomodule',
        'novalidate',
        'open',
        'playsinline',
        'readonly',
        'required',
        'reversed',
        'selected',
    ],
    Se = (e, t) => {
        for (let n = 0, i = e.length; n < i; n++) {
            const r = e[n]
            if (typeof r == 'string') j(r, t)
            else {
                if (typeof r == 'boolean' || r === null || r === void 0)
                    continue
                r instanceof $
                    ? r.toStringToBuffer(t)
                    : typeof r == 'number' || r.isEscaped
                      ? (t[0] += r)
                      : r instanceof Promise
                        ? t.unshift('', r)
                        : Se(r, t)
            }
        }
    },
    $ = class {
        constructor(e, t, n) {
            M(this, 'tag')
            M(this, 'props')
            M(this, 'key')
            M(this, 'children')
            M(this, 'isEscaped', !0)
            M(this, 'localContexts')
            ;(this.tag = e), (this.props = t), (this.children = n)
        }
        get type() {
            return this.tag
        }
        get ref() {
            return this.props.ref || null
        }
        toString() {
            var t, n
            const e = ['']
            ;(t = this.localContexts) == null ||
                t.forEach(([i, r]) => {
                    i.values.push(r)
                })
            try {
                this.toStringToBuffer(e)
            } finally {
                ;(n = this.localContexts) == null ||
                    n.forEach(([i]) => {
                        i.values.pop()
                    })
            }
            return e.length === 1
                ? 'callbacks' in e
                    ? ct(T(e[0], e.callbacks)).toString()
                    : e[0]
                : ot(e, e.callbacks)
        }
        toStringToBuffer(e) {
            const t = this.tag,
                n = this.props
            let { children: i } = this
            e[0] += `<${t}`
            const r = F && I(F) === 'svg' ? (s) => Ct(te(s)) : (s) => te(s)
            for (let [s, a] of Object.entries(n))
                if (((s = r(s)), s !== 'children')) {
                    if (s === 'style' && typeof a == 'object') {
                        let l = ''
                        qe(a, (f, y) => {
                            y != null && (l += `${l ? ';' : ''}${f}:${y}`)
                        }),
                            (e[0] += ' style="'),
                            j(l, e),
                            (e[0] += '"')
                    } else if (typeof a == 'string')
                        (e[0] += ` ${s}="`), j(a, e), (e[0] += '"')
                    else if (a != null)
                        if (typeof a == 'number' || a.isEscaped)
                            e[0] += ` ${s}="${a}"`
                        else if (typeof a == 'boolean' && kt.includes(s))
                            a && (e[0] += ` ${s}=""`)
                        else if (s === 'dangerouslySetInnerHTML') {
                            if (i.length > 0)
                                throw 'Can only set one of `children` or `props.dangerouslySetInnerHTML`.'
                            i = [T(a.__html)]
                        } else if (a instanceof Promise)
                            (e[0] += ` ${s}="`), e.unshift('"', a)
                        else if (typeof a == 'function') {
                            if (!s.startsWith('on'))
                                throw `Invalid prop '${s}' of type 'function' supplied to '${t}'.`
                        } else
                            (e[0] += ` ${s}="`),
                                j(a.toString(), e),
                                (e[0] += '"')
                }
            if (bt.includes(t) && i.length === 0) {
                e[0] += '/>'
                return
            }
            ;(e[0] += '>'), Se(i, e), (e[0] += `</${t}>`)
        }
    },
    le = class extends $ {
        toStringToBuffer(e) {
            const { children: t } = this,
                n = this.tag.call(null, {
                    ...this.props,
                    children: t.length <= 1 ? t[0] : t,
                })
            if (!(typeof n == 'boolean' || n == null))
                if (n instanceof Promise)
                    if (D.length === 0) e.unshift('', n)
                    else {
                        const i = D.map((r) => [r, r.values.at(-1)])
                        e.unshift(
                            '',
                            n.then(
                                (r) => (
                                    r instanceof $ && (r.localContexts = i), r
                                )
                            )
                        )
                    }
                else
                    n instanceof $
                        ? n.toStringToBuffer(e)
                        : typeof n == 'number' || n.isEscaped
                          ? ((e[0] += n),
                            n.callbacks &&
                                (e.callbacks || (e.callbacks = []),
                                e.callbacks.push(...n.callbacks)))
                          : j(n, e)
        }
    },
    Ue = class extends $ {
        toStringToBuffer(e) {
            Se(this.children, e)
        }
    },
    Te = !1,
    oe = (e, t, n) => {
        if (!Te) {
            for (const i in ye) ae[i][ie] = ye[i]
            Te = !0
        }
        return typeof e == 'function'
            ? new le(e, t, n)
            : ae[e]
              ? new le(ae[e], t, n)
              : e === 'svg' || e === 'head'
                ? (F || (F = ut('')), new $(e, t, [new le(F, { value: e }, n)]))
                : new $(e, t, n)
    },
    At = ({ children: e }) =>
        new Ue('', { children: e }, Array.isArray(e) ? e : e ? [e] : [])
function w(e, t, n) {
    let i
    if (!t || !('children' in t)) i = oe(e, t, [])
    else {
        const r = t.children
        i = Array.isArray(r) ? oe(e, t, r) : oe(e, t, [r])
    }
    return (i.key = n), i
}
var H = '_hp',
    $t = { Change: 'Input', DoubleClick: 'DblClick' },
    wt = { svg: '2000/svg', math: '1998/Math/MathML' },
    W = [],
    me = new WeakMap(),
    _ = void 0,
    Tt = () => _,
    R = (e) => 't' in e,
    ce = { onClick: ['click', !1] },
    Pe = (e) => {
        if (!e.startsWith('on')) return
        if (ce[e]) return ce[e]
        const t = e.match(/^on([A-Z][a-zA-Z]+?(?:PointerCapture)?)(Capture)?$/)
        if (t) {
            const [, n, i] = t
            return (ce[e] = [($t[n] || n).toLowerCase(), !!i])
        }
    },
    Re = (e, t) =>
        _ &&
        e instanceof SVGElement &&
        /[A-Z]/.test(t) &&
        (t in e.style || t.match(/^(?:o|pai|str|u|ve)/))
            ? t.replace(/([A-Z])/g, '-$1').toLowerCase()
            : t,
    Pt = (e, t, n) => {
        var i
        t || (t = {})
        for (let r in t) {
            const s = t[r]
            if (r !== 'children' && (!n || n[r] !== s)) {
                r = te(r)
                const a = Pe(r)
                if (a) {
                    if (
                        (n == null ? void 0 : n[r]) !== s &&
                        (n && e.removeEventListener(a[0], n[r], a[1]),
                        s != null)
                    ) {
                        if (typeof s != 'function')
                            throw new Error(
                                `Event handler for "${r}" is not a function`
                            )
                        e.addEventListener(a[0], s, a[1])
                    }
                } else if (r === 'dangerouslySetInnerHTML' && s)
                    e.innerHTML = s.__html
                else if (r === 'ref') {
                    let l
                    typeof s == 'function'
                        ? (l = s(e) || (() => s(null)))
                        : s &&
                          'current' in s &&
                          ((s.current = e), (l = () => (s.current = null))),
                        me.set(e, l)
                } else if (r === 'style') {
                    const l = e.style
                    typeof s == 'string'
                        ? (l.cssText = s)
                        : ((l.cssText = ''),
                          s != null && qe(s, l.setProperty.bind(l)))
                } else {
                    if (r === 'value') {
                        const f = e.nodeName
                        if (
                            f === 'INPUT' ||
                            f === 'TEXTAREA' ||
                            f === 'SELECT'
                        ) {
                            if (
                                ((e.value = s == null || s === !1 ? null : s),
                                f === 'TEXTAREA')
                            ) {
                                e.textContent = s
                                continue
                            } else if (f === 'SELECT') {
                                e.selectedIndex === -1 && (e.selectedIndex = 0)
                                continue
                            }
                        }
                    } else
                        ((r === 'checked' && e.nodeName === 'INPUT') ||
                            (r === 'selected' && e.nodeName === 'OPTION')) &&
                            (e[r] = s)
                    const l = Re(e, r)
                    s == null || s === !1
                        ? e.removeAttribute(l)
                        : s === !0
                          ? e.setAttribute(l, '')
                          : typeof s == 'string' || typeof s == 'number'
                            ? e.setAttribute(l, s)
                            : e.setAttribute(l, s.toString())
                }
            }
        }
        if (n)
            for (let r in n) {
                const s = n[r]
                if (r !== 'children' && !(r in t)) {
                    r = te(r)
                    const a = Pe(r)
                    a
                        ? e.removeEventListener(a[0], s, a[1])
                        : r === 'ref'
                          ? (i = me.get(e)) == null || i()
                          : e.removeAttribute(Re(e, r))
                }
            }
    },
    Rt = (e, t) => {
        ;(t[C][0] = 0), W.push([e, t])
        const n = t.tag[ie] || t.tag,
            i = n.defaultProps ? { ...n.defaultProps, ...t.props } : t.props
        try {
            return [n.call(null, i)]
        } finally {
            W.pop()
        }
    },
    Ze = (e, t, n, i, r) => {
        var s, a
        ;(s = e.vR) != null && s.length && (i.push(...e.vR), delete e.vR),
            typeof e.tag == 'function' &&
                ((a = e[C][1][Ke]) == null || a.forEach((l) => r.push(l))),
            e.vC.forEach((l) => {
                var f
                if (R(l)) n.push(l)
                else if (typeof l.tag == 'function' || l.tag === '') {
                    l.c = t
                    const y = n.length
                    if ((Ze(l, t, n, i, r), l.s)) {
                        for (let d = y; d < n.length; d++) n[d].s = !0
                        l.s = !1
                    }
                } else
                    n.push(l),
                        (f = l.vR) != null &&
                            f.length &&
                            (i.push(...l.vR), delete l.vR)
            })
    },
    xt = (e) => {
        for (; ; e = e.tag === H || !e.vC || !e.pP ? e.nN : e.vC[0]) {
            if (!e) return null
            if (e.tag !== H && e.e) return e.e
        }
    },
    ze = (e) => {
        var t, n, i, r, s, a
        R(e) ||
            ((n = (t = e[C]) == null ? void 0 : t[1][Ke]) == null ||
                n.forEach((l) => {
                    var f
                    return (f = l[2]) == null ? void 0 : f.call(l)
                }),
            (i = me.get(e.e)) == null || i(),
            e.p === 2 && ((r = e.vC) == null || r.forEach((l) => (l.p = 2))),
            (s = e.vC) == null || s.forEach(ze)),
            e.p || ((a = e.e) == null || a.remove(), delete e.e),
            typeof e.tag == 'function' &&
                (B.delete(e), Y.delete(e), delete e[C][3], (e.a = !0))
    },
    Ee = (e, t, n) => {
        ;(e.c = t), Ge(e, t, n)
    },
    xe = (e, t) => {
        if (t) {
            for (let n = 0, i = e.length; n < i; n++) if (e[n] === t) return n
        }
    },
    Le = Symbol(),
    Ge = (e, t, n) => {
        var y
        const i = [],
            r = [],
            s = []
        Ze(e, t, i, r, s), r.forEach(ze)
        const a = n ? void 0 : t.childNodes
        let l,
            f = null
        if (n) l = -1
        else if (!a.length) l = 0
        else {
            const d = xe(a, xt(e.nN))
            d !== void 0
                ? ((f = a[d]), (l = d))
                : (l =
                      xe(
                          a,
                          (y = i.find((u) => u.tag !== H && u.e)) == null
                              ? void 0
                              : y.e
                      ) ?? -1),
                l === -1 && (n = !0)
        }
        for (let d = 0, u = i.length; d < u; d++, l++) {
            const o = i[d]
            let c
            if (o.s && o.e) (c = o.e), (o.s = !1)
            else {
                const h = n || !o.e
                R(o)
                    ? (o.e && o.d && (o.e.textContent = o.t),
                      (o.d = !1),
                      (c = o.e || (o.e = document.createTextNode(o.t))))
                    : ((c =
                          o.e ||
                          (o.e = o.n
                              ? document.createElementNS(o.n, o.tag)
                              : document.createElement(o.tag))),
                      Pt(c, o.props, o.pP),
                      Ge(o, c, h))
            }
            o.tag === H
                ? l--
                : n
                  ? c.parentNode || t.appendChild(c)
                  : a[l] !== c &&
                    a[l - 1] !== c &&
                    (a[l + 1] === c
                        ? t.appendChild(a[l])
                        : t.insertBefore(c, f || a[l] || null))
        }
        if ((e.pP && delete e.pP, s.length)) {
            const d = [],
                u = []
            s.forEach(([, o, , c, h]) => {
                o && d.push(o), c && u.push(c), h == null || h()
            }),
                d.forEach((o) => o()),
                u.length &&
                    requestAnimationFrame(() => {
                        u.forEach((o) => o())
                    })
        }
    },
    Y = new WeakMap(),
    ne = (e, t, n) => {
        var s, a, l, f, y, d
        const i = !n && t.pC
        n && (t.pC || (t.pC = t.vC))
        let r
        try {
            n ||
                (n =
                    typeof t.tag == 'function'
                        ? Rt(e, t)
                        : q(t.props.children)),
                ((s = n[0]) == null ? void 0 : s.tag) === '' &&
                    n[0][he] &&
                    ((r = n[0][he]), e[5].push([e, r, t]))
            const u = i ? [...t.pC] : t.vC ? [...t.vC] : void 0,
                o = []
            let c
            for (let h = 0; h < n.length; h++) {
                Array.isArray(n[h]) && n.splice(h, 1, ...n[h].flat())
                let v = Je(n[h])
                if (v) {
                    typeof v.tag == 'function' &&
                        !v.tag[Ie] &&
                        (D.length > 0 &&
                            (v[C][2] = D.map((m) => [m, m.values.at(-1)])),
                        (a = e[5]) != null &&
                            a.length &&
                            (v[C][3] = e[5].at(-1)))
                    let g
                    if (u && u.length) {
                        const m = u.findIndex(
                            R(v)
                                ? (p) => R(p)
                                : v.key !== void 0
                                  ? (p) => p.key === v.key && p.tag === v.tag
                                  : (p) => p.tag === v.tag
                        )
                        m !== -1 && ((g = u[m]), u.splice(m, 1))
                    }
                    if (g)
                        if (R(v))
                            g.t !== v.t && ((g.t = v.t), (g.d = !0)), (v = g)
                        else {
                            const m = (g.pP = g.props)
                            ;(g.props = v.props),
                                g.f || (g.f = v.f || t.f),
                                typeof v.tag == 'function' &&
                                    ((g[C][2] = v[C][2] || []),
                                    (g[C][3] = v[C][3]),
                                    !g.f &&
                                        ((g.o || g) === v.o ||
                                            ((f = (l = g.tag)[ft]) != null &&
                                                f.call(l, m, g.props))) &&
                                        (g.s = !0)),
                                (v = g)
                        }
                    else if (!R(v) && _) {
                        const m = I(_)
                        m && (v.n = m)
                    }
                    if (
                        (!R(v) && !v.s && (ne(e, v), delete v.f),
                        o.push(v),
                        c && !c.s && !v.s)
                    )
                        for (
                            let m = c;
                            m && !R(m);
                            m = (y = m.vC) == null ? void 0 : y.at(-1)
                        )
                            m.nN = v
                    c = v
                }
            }
            ;(t.vR = i ? [...t.vC, ...(u || [])] : u || []),
                (t.vC = o),
                i && delete t.pC
        } catch (u) {
            if (((t.f = !0), u === Le)) {
                if (r) return
                throw u
            }
            const [o, c, h] = ((d = t[C]) == null ? void 0 : d[3]) || []
            if (c) {
                const v = () => Q([0, !1, e[2]], h),
                    g = Y.get(h) || []
                g.push(v), Y.set(h, g)
                const m = c(u, () => {
                    const p = Y.get(h)
                    if (p) {
                        const E = p.indexOf(v)
                        if (E !== -1) return p.splice(E, 1), v()
                    }
                })
                if (m) {
                    if (e[0] === 1) e[1] = !0
                    else if (
                        (ne(e, h, [m]), (c.length === 1 || e !== o) && h.c)
                    ) {
                        Ee(h, h.c, !1)
                        return
                    }
                    throw Le
                }
            }
            throw u
        } finally {
            r && e[5].pop()
        }
    },
    Je = (e) => {
        if (!(e == null || typeof e == 'boolean')) {
            if (typeof e == 'string' || typeof e == 'number')
                return { t: e.toString(), d: !0 }
            if (
                ('vR' in e &&
                    (e = {
                        tag: e.tag,
                        props: e.props,
                        key: e.key,
                        f: e.f,
                        type: e.tag,
                        ref: e.props.ref,
                        o: e.o || e,
                    }),
                typeof e.tag == 'function')
            )
                e[C] = [0, []]
            else {
                const t = wt[e.tag]
                t &&
                    (_ || (_ = Fe('')),
                    (e.props.children = [
                        {
                            tag: _,
                            props: {
                                value: (e.n = `http://www.w3.org/${t}`),
                                children: e.props.children,
                            },
                        },
                    ]))
            }
            return e
        }
    },
    Xe = (e, t, n) => {
        e.c === t && ((e.c = n), e.vC.forEach((i) => Xe(i, t, n)))
    },
    Me = (e, t) => {
        var n, i
        ;(n = t[C][2]) == null ||
            n.forEach(([r, s]) => {
                r.values.push(s)
            })
        try {
            ne(e, t, void 0)
        } catch {
            return
        }
        if (t.a) {
            delete t.a
            return
        }
        ;(i = t[C][2]) == null ||
            i.forEach(([r]) => {
                r.values.pop()
            }),
            (e[0] !== 1 || !e[1]) && Ee(t, t.c, !1)
    },
    B = new WeakMap(),
    Oe = [],
    Q = async (e, t) => {
        e[5] || (e[5] = [])
        const n = B.get(t)
        n && n[0](void 0)
        let i
        const r = new Promise((s) => (i = s))
        if (
            (B.set(t, [
                i,
                () => {
                    e[2]
                        ? e[2](e, t, (s) => {
                              Me(s, t)
                          }).then(() => i(t))
                        : (Me(e, t), i(t))
                },
            ]),
            Oe.length)
        )
            Oe.at(-1).add(t)
        else {
            await Promise.resolve()
            const s = B.get(t)
            s && (B.delete(t), s[1]())
        }
        return r
    },
    Lt = (e, t) => {
        const n = []
        ;(n[5] = []), (n[4] = !0), ne(n, e, void 0), (n[4] = !1)
        const i = document.createDocumentFragment()
        Ee(e, i, !0), Xe(e, i, t), t.replaceChildren(i)
    },
    Mt = (e, t, n) => ({ tag: H, props: { children: e }, key: n, e: t, p: 1 }),
    fe = 0,
    Ke = 1,
    ue = 2,
    de = 3,
    ve = new WeakMap(),
    Ve = (e, t) =>
        !e || !t || e.length !== t.length || t.some((n, i) => n !== e[i]),
    Ot = void 0,
    Ne = [],
    re = (e) => {
        var a
        const t = () => (typeof e == 'function' ? e() : e),
            n = W.at(-1)
        if (!n) return [t(), () => {}]
        const [, i] = n,
            r = (a = i[C][1])[fe] || (a[fe] = []),
            s = i[C][0]++
        return (
            r[s] ||
            (r[s] = [
                t(),
                (l) => {
                    const f = Ot,
                        y = r[s]
                    if (
                        (typeof l == 'function' && (l = l(y[0])),
                        !Object.is(l, y[0]))
                    )
                        if (((y[0] = l), Ne.length)) {
                            const [d, u] = Ne.at(-1)
                            Promise.all([
                                d === 3 ? i : Q([d, !1, f], i),
                                u,
                            ]).then(([o]) => {
                                if (!o || !(d === 2 || d === 3)) return
                                const c = o.vC
                                requestAnimationFrame(() => {
                                    setTimeout(() => {
                                        c === o.vC &&
                                            Q([d === 3 ? 1 : 0, !1, f], o)
                                    })
                                })
                            })
                        } else Q([0, !1, f], i)
                },
            ])
        )
    },
    Ce = (e, t) => {
        var l
        const n = W.at(-1)
        if (!n) return e
        const [, i] = n,
            r = (l = i[C][1])[ue] || (l[ue] = []),
            s = i[C][0]++,
            a = r[s]
        return (
            Ve(a == null ? void 0 : a[1], t) ? (r[s] = [e, t]) : (e = r[s][0]),
            e
        )
    },
    Nt = (e) => {
        const t = ve.get(e)
        if (t) {
            if (t.length === 2) throw t[1]
            return t[0]
        }
        throw (
            (e.then(
                (n) => ve.set(e, [n]),
                (n) => ve.set(e, [void 0, n])
            ),
            e)
        )
    },
    jt = (e, t) => {
        var l
        const n = W.at(-1)
        if (!n) return e()
        const [, i] = n,
            r = (l = i[C][1])[de] || (l[de] = []),
            s = i[C][0]++,
            a = r[s]
        return Ve(a == null ? void 0 : a[1], t) && (r[s] = [e(), t]), r[s][0]
    },
    Dt = Fe({ pending: !1, data: null, method: null, action: null }),
    je = new Set(),
    _t = (e) => {
        je.add(e), e.finally(() => je.delete(e))
    },
    be = (e, t) =>
        jt(
            () => (n) => {
                let i
                e &&
                    (typeof e == 'function'
                        ? (i =
                              e(n) ||
                              (() => {
                                  e(null)
                              }))
                        : e &&
                          'current' in e &&
                          ((e.current = n),
                          (i = () => {
                              e.current = null
                          })))
                const r = t(n)
                return () => {
                    r == null || r(), i == null || i()
                }
            },
            [e]
        ),
    N = Object.create(null),
    X = Object.create(null),
    z = (e, t, n, i, r) => {
        if (t != null && t.itemProp)
            return { tag: e, props: t, type: e, ref: t.ref }
        const s = document.head
        let { onLoad: a, onError: l, precedence: f, blocking: y, ...d } = t,
            u = null,
            o = !1
        const c = K[e]
        let h
        if (c.length > 0) {
            const p = s.querySelectorAll(e)
            e: for (const E of p)
                for (const S of K[e])
                    if (E.getAttribute(S) === t[S]) {
                        u = E
                        break e
                    }
            if (!u) {
                const E = c.reduce(
                    (S, b) => (t[b] === void 0 ? S : `${S}-${b}-${t[b]}`),
                    e
                )
                ;(o = !X[E]),
                    (u =
                        X[E] ||
                        (X[E] = (() => {
                            const S = document.createElement(e)
                            for (const b of c)
                                t[b] !== void 0 && S.setAttribute(b, t[b]),
                                    t.rel && S.setAttribute('rel', t.rel)
                            return S
                        })()))
            }
        } else h = s.querySelectorAll(e)
        ;(f = i ? (f ?? '') : void 0), i && (d[V] = f)
        const v = Ce(
                (p) => {
                    if (c.length > 0) {
                        let E = !1
                        for (const S of s.querySelectorAll(e)) {
                            if (E && S.getAttribute(V) !== f) {
                                s.insertBefore(p, S)
                                return
                            }
                            S.getAttribute(V) === f && (E = !0)
                        }
                        s.appendChild(p)
                    } else if (h) {
                        let E = !1
                        for (const S of h)
                            if (S === p) {
                                E = !0
                                break
                            }
                        E ||
                            s.insertBefore(
                                p,
                                s.contains(h[0]) ? h[0] : s.querySelector(e)
                            ),
                            (h = void 0)
                    }
                },
                [f]
            ),
            g = be(t.ref, (p) => {
                var b
                const E = c[0]
                if ((n === 2 && (p.innerHTML = ''), (o || h) && v(p), !l && !a))
                    return
                let S =
                    N[(b = p.getAttribute(E))] ||
                    (N[b] = new Promise((P, J) => {
                        p.addEventListener('load', P),
                            p.addEventListener('error', J)
                    }))
                a && (S = S.then(a)), l && (S = S.catch(l)), S.catch(() => {})
            })
        if (r && y === 'render') {
            const p = K[e][0]
            if (t[p]) {
                const E = t[p],
                    S =
                        N[E] ||
                        (N[E] = new Promise((b, P) => {
                            v(u),
                                u.addEventListener('load', b),
                                u.addEventListener('error', P)
                        }))
                Nt(S)
            }
        }
        const m = { tag: e, type: e, props: { ...d, ref: g }, ref: g }
        return (m.p = n), u && (m.e = u), Mt(m, s)
    },
    It = (e) => {
        const t = Tt(),
            n = t && I(t)
        return n != null && n.endsWith('svg')
            ? { tag: 'title', props: e, type: 'title', ref: e.ref }
            : z('title', e, void 0, !1, !1)
    },
    Bt = (e) =>
        !e || ['src', 'async'].some((t) => !e[t])
            ? { tag: 'script', props: e, type: 'script', ref: e.ref }
            : z('script', e, 1, !1, !0),
    Ft = (e) =>
        !e || !['href', 'precedence'].every((t) => t in e)
            ? { tag: 'style', props: e, type: 'style', ref: e.ref }
            : ((e['data-href'] = e.href),
              delete e.href,
              z('style', e, 2, !0, !0)),
    Ht = (e) =>
        !e ||
        ['onLoad', 'onError'].some((t) => t in e) ||
        (e.rel === 'stylesheet' && (!('precedence' in e) || 'disabled' in e))
            ? { tag: 'link', props: e, type: 'link', ref: e.ref }
            : z('link', e, 1, 'precedence' in e, !0),
    Wt = (e) => z('meta', e, void 0, !1, !1),
    Ye = Symbol(),
    qt = (e) => {
        const { action: t, ...n } = e
        typeof t != 'function' && (n.action = t)
        const [i, r] = re([null, !1]),
            s = Ce(async (y) => {
                const d = y.isTrusted ? t : y.detail[Ye]
                if (typeof d != 'function') return
                y.preventDefault()
                const u = new FormData(y.target)
                r([u, !0])
                const o = d(u)
                o instanceof Promise && (_t(o), await o), r([null, !0])
            }, []),
            a = be(
                e.ref,
                (y) => (
                    y.addEventListener('submit', s),
                    () => {
                        y.removeEventListener('submit', s)
                    }
                )
            ),
            [l, f] = i
        return (
            (i[1] = !1),
            {
                tag: Dt,
                props: {
                    value: {
                        pending: l !== null,
                        data: l,
                        method: l ? 'post' : null,
                        action: l ? t : null,
                    },
                    children: {
                        tag: 'form',
                        props: { ...n, ref: a },
                        type: 'form',
                        ref: a,
                    },
                },
                f,
            }
        )
    },
    Qe = (e, { formAction: t, ...n }) => {
        if (typeof t == 'function') {
            const i = Ce((r) => {
                r.preventDefault(),
                    r.currentTarget.form.dispatchEvent(
                        new CustomEvent('submit', { detail: { [Ye]: t } })
                    )
            }, [])
            n.ref = be(
                n.ref,
                (r) => (
                    r.addEventListener('click', i),
                    () => {
                        r.removeEventListener('click', i)
                    }
                )
            )
        }
        return { tag: e, props: n, type: e, ref: n.ref }
    },
    Ut = (e) => Qe('input', e),
    Zt = (e) => Qe('button', e)
Object.assign(ye, {
    title: It,
    script: Bt,
    style: Ft,
    link: Ht,
    meta: Wt,
    form: qt,
    input: Ut,
    button: Zt,
})
new TextEncoder()
var zt = (e, t = {}) => {
        let n
        return (
            Object.keys(t).length > 0 &&
                console.warn('createRoot options are not supported yet'),
            {
                render(i) {
                    if (n === null)
                        throw new Error('Cannot update an unmounted root')
                    n
                        ? n(i)
                        : Lt(
                              Je({
                                  tag: () => {
                                      const [r, s] = re(i)
                                      return (n = s), r
                                  },
                                  props: {},
                              }),
                              e
                          )
                },
                unmount() {
                    n == null || n(null), (n = null)
                },
            }
        )
    },
    Gt = (e, t, n = {}) => {
        const i = zt(e, n)
        return i.render(t), i
    },
    G = ':-hono-global',
    Jt = new RegExp(`^${G}{(.*)}$`),
    Xt = 'hono-css',
    O = Symbol(),
    k = Symbol(),
    A = Symbol(),
    x = Symbol(),
    se = Symbol(),
    De = Symbol(),
    et = (e) => {
        let t = 0,
            n = 11
        for (; t < e.length; ) n = (101 * n + e.charCodeAt(t++)) >>> 0
        return 'css-' + n
    },
    Kt = [
        '"(?:(?:\\\\[\\s\\S]|[^"\\\\])*)"',
        "'(?:(?:\\\\[\\s\\S]|[^'\\\\])*)'",
    ].join('|'),
    Vt = new RegExp(
        [
            '(' + Kt + ')',
            '(?:' +
                [
                    '^\\s+',
                    '\\/\\*.*?\\*\\/\\s*',
                    '\\/\\/.*\\n\\s*',
                    '\\s+$',
                ].join('|') +
                ')',
            '\\s*;\\s*(}|$)\\s*',
            '\\s*([{};:,])\\s*',
            '(\\s)\\s+',
        ].join('|'),
        'g'
    ),
    Yt = (e) => e.replace(Vt, (t, n, i, r, s) => n || i || r || s || ''),
    tt = (e, t) => {
        var a, l
        const n = [],
            i = [],
            r =
                ((a = e[0].match(/^\s*\/\*(.*?)\*\//)) == null
                    ? void 0
                    : a[1]) || ''
        let s = ''
        for (let f = 0, y = e.length; f < y; f++) {
            s += e[f]
            let d = t[f]
            if (!(typeof d == 'boolean' || d === null || d === void 0)) {
                Array.isArray(d) || (d = [d])
                for (let u = 0, o = d.length; u < o; u++) {
                    let c = d[u]
                    if (!(typeof c == 'boolean' || c === null || c === void 0))
                        if (typeof c == 'string')
                            /([\\"'\/])/.test(c)
                                ? (s += c.replace(
                                      new RegExp(`([\\\\"']|(?<=<)\\/)`, 'g'),
                                      '\\$1'
                                  ))
                                : (s += c)
                        else if (typeof c == 'number') s += c
                        else if (c[De]) s += c[De]
                        else if (c[k].startsWith('@keyframes '))
                            n.push(c), (s += ` ${c[k].substring(11)} `)
                        else {
                            if ((l = e[f + 1]) != null && l.match(/^\s*{/))
                                n.push(c), (c = `.${c[k]}`)
                            else {
                                n.push(...c[x]), i.push(...c[se]), (c = c[A])
                                const h = c.length
                                if (h > 0) {
                                    const v = c[h - 1]
                                    v !== ';' && v !== '}' && (c += ';')
                                }
                            }
                            s += `${c || ''}`
                        }
                }
            }
        }
        return [r, Yt(s), n, i]
    },
    pe = (e, t) => {
        let [n, i, r, s] = tt(e, t)
        const a = Jt.exec(i)
        a && (i = a[1])
        const l = (a ? G : '') + et(n + i),
            f = (a ? r.map((y) => y[k]) : [l, ...s]).join(' ')
        return { [O]: l, [k]: f, [A]: i, [x]: r, [se]: s }
    },
    Qt = (e) => {
        for (let t = 0, n = e.length; t < n; t++) {
            const i = e[t]
            typeof i == 'string' &&
                (e[t] = { [O]: '', [k]: '', [A]: '', [x]: [], [se]: [i] })
        }
        return e
    },
    en = (e, ...t) => {
        const [n, i] = tt(e, t)
        return {
            [O]: '',
            [k]: `@keyframes ${et(n + i)}`,
            [A]: i,
            [x]: [],
            [se]: [],
        }
    },
    tn = 0,
    nn = (e, t) => {
        e || (e = [`/* h-v-t ${tn++} */`])
        const n = Array.isArray(e) ? pe(e, t) : e,
            i = n[k],
            r = pe(['view-transition-name:', ''], [i])
        return (
            (n[k] = G + n[k]),
            (n[A] = n[A].replace(
                new RegExp('(?<=::view-transition(?:[a-z-]*)\\()(?=\\))', 'g'),
                i
            )),
            (r[k] = r[O] = i),
            (r[x] = [...n[x], n]),
            r
        )
    },
    rn = (e) => {
        const t = []
        let n = 0,
            i = 0
        for (let r = 0, s = e.length; r < s; r++) {
            const a = e[r]
            if (a === "'" || a === '"') {
                const l = a
                for (r++; r < s; r++) {
                    if (e[r] === '\\') {
                        r++
                        continue
                    }
                    if (e[r] === l) break
                }
                continue
            }
            if (a === '{') {
                i++
                continue
            }
            if (a === '}') {
                i--, i === 0 && (t.push(e.slice(n, r + 1)), (n = r + 1))
                continue
            }
        }
        return t
    },
    sn = ({ id: e }) => {
        let t
        const n = () => {
                var a
                return (
                    t ||
                        ((t =
                            (a = document.querySelector(`style#${e}`)) == null
                                ? void 0
                                : a.sheet),
                        t && (t.addedStyles = new Set())),
                    t ? [t, t.addedStyles] : []
                )
            },
            i = (a, l) => {
                const [f, y] = n()
                if (!f || !y) {
                    Promise.resolve().then(() => {
                        if (!n()[0]) throw new Error('style sheet not found')
                        i(a, l)
                    })
                    return
                }
                y.has(a) ||
                    (y.add(a),
                    (a.startsWith(G)
                        ? rn(l)
                        : [`${a[0] === '@' ? '' : '.'}${a}{${l}}`]
                    ).forEach((d) => {
                        f.insertRule(d, f.cssRules.length)
                    }))
            }
        return [
            {
                toString() {
                    const a = this[O]
                    return (
                        i(a, this[A]),
                        this[x].forEach(({ [k]: l, [A]: f }) => {
                            i(l, f)
                        }),
                        this[k]
                    )
                },
            },
            ({ children: a, nonce: l }) => ({
                tag: 'style',
                props: {
                    id: e,
                    nonce: l,
                    children:
                        a && (Array.isArray(a) ? a : [a]).map((f) => f[A]),
                },
            }),
        ]
    },
    an = ({ id: e }) => {
        const [t, n] = sn({ id: e }),
            i = new WeakMap(),
            r = new WeakMap(),
            s = new RegExp(
                `(<style id="${e}"(?: nonce="[^"]*")?>.*?)(</style>)`
            ),
            a = (o) => {
                const c = ({ buffer: m, context: p }) => {
                        const [E, S] = i.get(p),
                            b = Object.keys(E)
                        if (!b.length) return
                        let P = ''
                        if (
                            (b.forEach((L) => {
                                ;(S[L] = !0),
                                    (P += L.startsWith(G)
                                        ? E[L]
                                        : `${L[0] === '@' ? '' : '.'}${L}{${E[L]}}`)
                            }),
                            i.set(p, [{}, S]),
                            m && s.test(m[0]))
                        ) {
                            m[0] = m[0].replace(
                                s,
                                (L, nt, rt) => `${nt}${P}${rt}`
                            )
                            return
                        }
                        const J = r.get(p),
                            ke = `<script${J ? ` nonce="${J}"` : ''}>document.querySelector('#${e}').textContent+=${JSON.stringify(P)}<\/script>`
                        if (m) {
                            m[0] = `${ke}${m[0]}`
                            return
                        }
                        return Promise.resolve(ke)
                    },
                    h = ({ context: m }) => {
                        i.has(m) || i.set(m, [{}, {}])
                        const [p, E] = i.get(m)
                        let S = !0
                        if (
                            (E[o[O]] || ((S = !1), (p[o[O]] = o[A])),
                            o[x].forEach(({ [k]: b, [A]: P }) => {
                                E[b] || ((S = !1), (p[b] = P))
                            }),
                            !S)
                        )
                            return Promise.resolve(T('', [c]))
                    },
                    v = new String(o[k])
                Object.assign(v, o), (v.isEscaped = !0), (v.callbacks = [h])
                const g = Promise.resolve(v)
                return Object.assign(g, o), (g.toString = t.toString), g
            },
            l = (o, ...c) => a(pe(o, c)),
            f = (...o) => ((o = Qt(o)), l(Array(o.length).fill(''), ...o)),
            y = en,
            d = (o, ...c) => a(nn(o, c)),
            u = ({ children: o, nonce: c } = {}) =>
                T(
                    `<style id="${e}"${c ? ` nonce="${c}"` : ''}>${o ? o[A] : ''}</style>`,
                    [
                        ({ context: h }) => {
                            r.set(h, c)
                        },
                    ]
                )
        return (
            (u[ie] = n),
            { css: l, cx: f, keyframes: y, viewTransition: d, Style: u }
        )
    },
    ln = an({ id: Xt }),
    on = ln.css
function cn() {
    const [e, t] = re(0),
        [n, i] = re()
    return w('section', {
        class: fn,
        children: w('div', {
            'content-grid': !0,
            children: [
                w('div', {
                    children: [
                        w('button', {
                            type: 'button',
                            onClick: () => {
                                console.log('Button clicked...'),
                                    t((r) => r + 1)
                            },
                            children: 'Increase count',
                        }),
                        w('span', { children: ['Count: ', e] }),
                    ],
                }),
                w('div', {
                    children: [
                        w('button', {
                            type: 'button',
                            onClick: () => {
                                console.log('Clicked button...')
                            },
                            disabled: !!n,
                            children: 'Fetch message',
                        }),
                        w('span', { children: n }),
                    ],
                }),
            ],
        }),
    })
}
const fn = on`
  display: grid;
  place-content: center;
  height: 100%;

  [content-grid] {
    display: grid;
    border: 1px solid;
    gap: 0.5rem;
    padding: 0.5rem;
    border-radius: 0.5rem;

    & > div {
      display: grid;
      grid-template-columns: 1fr minmax(400px, 30ch);
      gap: 0.5rem;
      align-items: start;
    }
  }
`,
    _e = document.getElementById('ssr-root')
_e && Gt(_e, w(At, { children: w(cn, {}) }))
