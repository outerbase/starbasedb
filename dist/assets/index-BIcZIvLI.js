var ot = Object.defineProperty
var ct = (e, t, n) =>
    t in e
        ? ot(e, t, { enumerable: !0, configurable: !0, writable: !0, value: n })
        : (e[t] = n)
var M = (e, t, n) => ct(e, typeof t != 'symbol' ? t + '' : t, n)
var ft = { Stringify: 1, BeforeStream: 2, Stream: 3 },
    T = (e, t) => {
        const n = new String(e)
        return (n.isEscaped = !0), (n.callbacks = t), n
    },
    ut = /[&<>'"]/,
    dt = async (e, t) => {
        let n = ''
        t || (t = [])
        const s = await Promise.all(e)
        for (let r = s.length - 1; (n += s[r]), r--, !(r < 0); r--) {
            let i = s[r]
            typeof i == 'object' && t.push(...(i.callbacks || []))
            const a = i.isEscaped
            if (
                ((i = await (typeof i == 'object' ? i.toString() : i)),
                typeof i == 'object' && t.push(...(i.callbacks || [])),
                i.isEscaped ?? a)
            )
                n += i
            else {
                const l = [n]
                j(i, l), (n = l[0])
            }
        }
        return T(n, t)
    },
    j = (e, t) => {
        const n = e.search(ut)
        if (n === -1) {
            t[0] += e
            return
        }
        let s,
            r,
            i = 0
        for (r = n; r < e.length; r++) {
            switch (e.charCodeAt(r)) {
                case 34:
                    s = '&quot;'
                    break
                case 39:
                    s = '&#39;'
                    break
                case 38:
                    s = '&amp;'
                    break
                case 60:
                    s = '&lt;'
                    break
                case 62:
                    s = '&gt;'
                    break
                default:
                    continue
            }
            ;(t[0] += e.substring(i, r) + s), (i = r + 1)
        }
        t[0] += e.substring(i, r)
    },
    vt = (e) => {
        const t = e.callbacks
        if (!(t != null && t.length)) return e
        const n = [e],
            s = {}
        return (
            t.forEach((r) => r({ phase: ft.Stringify, buffer: n, context: s })),
            n[0]
        )
    },
    se = Symbol('RENDERER'),
    he = Symbol('ERROR_HANDLER'),
    C = Symbol('STASH'),
    Be = Symbol('INTERNAL'),
    ht = Symbol('MEMO'),
    ee = Symbol('PERMALINK'),
    Ae = (e) => ((e[Be] = !0), e),
    Fe =
        (e) =>
        ({ value: t, children: n }) => {
            if (!n) return
            const s = {
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
                ? s.children.push(...n.flat())
                : s.children.push(n),
                s.children.push({
                    tag: Ae(() => {
                        e.pop()
                    }),
                    props: {},
                })
            const r = { tag: '', props: s, type: '' }
            return (
                (r[he] = (i) => {
                    throw (e.pop(), i)
                }),
                r
            )
        },
    He = (e) => {
        const t = [e],
            n = Fe(t)
        return (n.values = t), (n.Provider = n), D.push(n), n
    },
    D = [],
    yt = (e) => {
        const t = [e],
            n = (s) => {
                t.push(s.value)
                let r
                try {
                    r = s.children
                        ? (Array.isArray(s.children)
                              ? new Ze('', {}, s.children)
                              : s.children
                          ).toString()
                        : ''
                } finally {
                    t.pop()
                }
                return r instanceof Promise
                    ? r.then((i) => T(i, i.callbacks))
                    : T(r)
            }
        return (n.values = t), (n.Provider = n), (n[se] = Fe(t)), D.push(n), n
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
        (e, t, n, s) =>
        ({ buffer: r, context: i }) => {
            if (!r) return
            const a = $e.get(i) || {}
            $e.set(i, a)
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
                      ? l.push([t, n, s])
                      : l.unshift([t, n, s]),
                r[0].indexOf('</head>') !== -1)
            ) {
                let d
                if (s === void 0) d = l.map(([u]) => u)
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
    U = (e, t, n) => T(new w(e, n, q(t ?? [])).toString()),
    Z = (e, t, n, s) => {
        if ('itemProp' in n) return U(e, t, n)
        let { precedence: r, blocking: i, ...a } = n
        ;(r = s ? (r ?? '') : void 0), s && (a[V] = r)
        const l = new w(e, a, q(t || [])).toString()
        return l instanceof Promise
            ? l.then((f) => T(l, [...(f.callbacks || []), we(e, f, a, r)]))
            : T(l, [we(e, l, a, r)])
    },
    mt = ({ children: e, ...t }) => {
        const n = ge()
        if (n) {
            const s = I(n)
            if (s === 'svg' || s === 'head')
                return new w('title', t, q(e ?? []))
        }
        return Z('title', e, t, !1)
    },
    pt = ({ children: e, ...t }) => {
        const n = ge()
        return ['src', 'async'].some((s) => !t[s]) || (n && I(n) === 'head')
            ? U('script', e, t)
            : Z('script', e, t, !1)
    },
    gt = ({ children: e, ...t }) =>
        ['href', 'precedence'].every((n) => n in t)
            ? ((t['data-href'] = t.href), delete t.href, Z('style', e, t, !0))
            : U('style', e, t),
    St = ({ children: e, ...t }) =>
        ['onLoad', 'onError'].some((n) => n in t) ||
        (t.rel === 'stylesheet' && (!('precedence' in t) || 'disabled' in t))
            ? U('link', e, t)
            : Z('link', e, t, 'precedence' in t),
    Et = ({ children: e, ...t }) => {
        const n = ge()
        return n && I(n) === 'head' ? U('meta', e, t) : Z('meta', e, t, !1)
    },
    We = (e, { children: t, ...n }) => new w(e, n, q(t ?? [])),
    Ct = (e) => (
        typeof e.action == 'function' &&
            (e.action = ee in e.action ? e.action[ee] : void 0),
        We('form', e)
    ),
    qe = (e, t) => (
        typeof t.formAction == 'function' &&
            (t.formAction = ee in t.formAction ? t.formAction[ee] : void 0),
        We(e, t)
    ),
    bt = (e) => qe('input', e),
    kt = (e) => qe('button', e)
const ae = Object.freeze(
    Object.defineProperty(
        {
            __proto__: null,
            button: kt,
            form: Ct,
            input: bt,
            link: St,
            meta: Et,
            script: pt,
            style: gt,
            title: mt,
        },
        Symbol.toStringTag,
        { value: 'Module' }
    )
)
var At = new Map([
        ['className', 'class'],
        ['htmlFor', 'for'],
        ['crossOrigin', 'crossorigin'],
        ['httpEquiv', 'http-equiv'],
        ['itemProp', 'itemprop'],
        ['fetchPriority', 'fetchpriority'],
        ['noModule', 'nomodule'],
        ['formAction', 'formaction'],
    ]),
    te = (e) => At.get(e) || e,
    Ue = (e, t) => {
        for (const [n, s] of Object.entries(e)) {
            const r =
                n[0] === '-' || !/[A-Z]/.test(n)
                    ? n
                    : n.replace(/[A-Z]/g, (i) => `-${i.toLowerCase()}`)
            t(
                r,
                s == null
                    ? null
                    : typeof s == 'number'
                      ? r.match(
                            /^(?:a|border-im|column(?:-c|s)|flex(?:$|-[^b])|grid-(?:ar|[^a])|font-w|li|or|sca|st|ta|wido|z)|ty$/
                        )
                          ? `${s}`
                          : `${s}px`
                      : s
            )
        }
    },
    F = void 0,
    ge = () => F,
    $t = (e) =>
        /[A-Z]/.test(e) &&
        e.match(
            /^(?:al|basel|clip(?:Path|Rule)$|co|do|fill|fl|fo|gl|let|lig|i|marker[EMS]|o|pai|pointe|sh|st[or]|text[^L]|tr|u|ve|w)/
        )
            ? e.replace(/([A-Z])/g, '-$1').toLowerCase()
            : e,
    wt = [
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
    Tt = [
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
        for (let n = 0, s = e.length; n < s; n++) {
            const r = e[n]
            if (typeof r == 'string') j(r, t)
            else {
                if (typeof r == 'boolean' || r === null || r === void 0)
                    continue
                r instanceof w
                    ? r.toStringToBuffer(t)
                    : typeof r == 'number' || r.isEscaped
                      ? (t[0] += r)
                      : r instanceof Promise
                        ? t.unshift('', r)
                        : Se(r, t)
            }
        }
    },
    w = class {
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
                t.forEach(([s, r]) => {
                    s.values.push(r)
                })
            try {
                this.toStringToBuffer(e)
            } finally {
                ;(n = this.localContexts) == null ||
                    n.forEach(([s]) => {
                        s.values.pop()
                    })
            }
            return e.length === 1
                ? 'callbacks' in e
                    ? vt(T(e[0], e.callbacks)).toString()
                    : e[0]
                : dt(e, e.callbacks)
        }
        toStringToBuffer(e) {
            const t = this.tag,
                n = this.props
            let { children: s } = this
            e[0] += `<${t}`
            const r = F && I(F) === 'svg' ? (i) => $t(te(i)) : (i) => te(i)
            for (let [i, a] of Object.entries(n))
                if (((i = r(i)), i !== 'children')) {
                    if (i === 'style' && typeof a == 'object') {
                        let l = ''
                        Ue(a, (f, y) => {
                            y != null && (l += `${l ? ';' : ''}${f}:${y}`)
                        }),
                            (e[0] += ' style="'),
                            j(l, e),
                            (e[0] += '"')
                    } else if (typeof a == 'string')
                        (e[0] += ` ${i}="`), j(a, e), (e[0] += '"')
                    else if (a != null)
                        if (typeof a == 'number' || a.isEscaped)
                            e[0] += ` ${i}="${a}"`
                        else if (typeof a == 'boolean' && Tt.includes(i))
                            a && (e[0] += ` ${i}=""`)
                        else if (i === 'dangerouslySetInnerHTML') {
                            if (s.length > 0)
                                throw 'Can only set one of `children` or `props.dangerouslySetInnerHTML`.'
                            s = [T(a.__html)]
                        } else if (a instanceof Promise)
                            (e[0] += ` ${i}="`), e.unshift('"', a)
                        else if (typeof a == 'function') {
                            if (!i.startsWith('on'))
                                throw `Invalid prop '${i}' of type 'function' supplied to '${t}'.`
                        } else
                            (e[0] += ` ${i}="`),
                                j(a.toString(), e),
                                (e[0] += '"')
                }
            if (wt.includes(t) && s.length === 0) {
                e[0] += '/>'
                return
            }
            ;(e[0] += '>'), Se(s, e), (e[0] += `</${t}>`)
        }
    },
    le = class extends w {
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
                        const s = D.map((r) => [r, r.values.at(-1)])
                        e.unshift(
                            '',
                            n.then(
                                (r) => (
                                    r instanceof w && (r.localContexts = s), r
                                )
                            )
                        )
                    }
                else
                    n instanceof w
                        ? n.toStringToBuffer(e)
                        : typeof n == 'number' || n.isEscaped
                          ? ((e[0] += n),
                            n.callbacks &&
                                (e.callbacks || (e.callbacks = []),
                                e.callbacks.push(...n.callbacks)))
                          : j(n, e)
        }
    },
    Ze = class extends w {
        toStringToBuffer(e) {
            Se(this.children, e)
        }
    },
    Te = !1,
    oe = (e, t, n) => {
        if (!Te) {
            for (const s in ye) ae[s][se] = ye[s]
            Te = !0
        }
        return typeof e == 'function'
            ? new le(e, t, n)
            : ae[e]
              ? new le(ae[e], t, n)
              : e === 'svg' || e === 'head'
                ? (F || (F = yt('')), new w(e, t, [new le(F, { value: e }, n)]))
                : new w(e, t, n)
    },
    ze = ({ children: e }) =>
        new Ze('', { children: e }, Array.isArray(e) ? e : e ? [e] : [])
function A(e, t, n) {
    let s
    if (!t || !('children' in t)) s = oe(e, t, [])
    else {
        const r = t.children
        s = Array.isArray(r) ? oe(e, t, r) : oe(e, t, [r])
    }
    return (s.key = n), s
}
var H = '_hp',
    Rt = { Change: 'Input', DoubleClick: 'DblClick' },
    Pt = { svg: '2000/svg', math: '1998/Math/MathML' },
    W = [],
    me = new WeakMap(),
    _ = void 0,
    xt = () => _,
    P = (e) => 't' in e,
    ce = { onClick: ['click', !1] },
    Re = (e) => {
        if (!e.startsWith('on')) return
        if (ce[e]) return ce[e]
        const t = e.match(/^on([A-Z][a-zA-Z]+?(?:PointerCapture)?)(Capture)?$/)
        if (t) {
            const [, n, s] = t
            return (ce[e] = [(Rt[n] || n).toLowerCase(), !!s])
        }
    },
    Pe = (e, t) =>
        _ &&
        e instanceof SVGElement &&
        /[A-Z]/.test(t) &&
        (t in e.style || t.match(/^(?:o|pai|str|u|ve)/))
            ? t.replace(/([A-Z])/g, '-$1').toLowerCase()
            : t,
    Lt = (e, t, n) => {
        var s
        t || (t = {})
        for (let r in t) {
            const i = t[r]
            if (r !== 'children' && (!n || n[r] !== i)) {
                r = te(r)
                const a = Re(r)
                if (a) {
                    if (
                        (n == null ? void 0 : n[r]) !== i &&
                        (n && e.removeEventListener(a[0], n[r], a[1]),
                        i != null)
                    ) {
                        if (typeof i != 'function')
                            throw new Error(
                                `Event handler for "${r}" is not a function`
                            )
                        e.addEventListener(a[0], i, a[1])
                    }
                } else if (r === 'dangerouslySetInnerHTML' && i)
                    e.innerHTML = i.__html
                else if (r === 'ref') {
                    let l
                    typeof i == 'function'
                        ? (l = i(e) || (() => i(null)))
                        : i &&
                          'current' in i &&
                          ((i.current = e), (l = () => (i.current = null))),
                        me.set(e, l)
                } else if (r === 'style') {
                    const l = e.style
                    typeof i == 'string'
                        ? (l.cssText = i)
                        : ((l.cssText = ''),
                          i != null && Ue(i, l.setProperty.bind(l)))
                } else {
                    if (r === 'value') {
                        const f = e.nodeName
                        if (
                            f === 'INPUT' ||
                            f === 'TEXTAREA' ||
                            f === 'SELECT'
                        ) {
                            if (
                                ((e.value = i == null || i === !1 ? null : i),
                                f === 'TEXTAREA')
                            ) {
                                e.textContent = i
                                continue
                            } else if (f === 'SELECT') {
                                e.selectedIndex === -1 && (e.selectedIndex = 0)
                                continue
                            }
                        }
                    } else
                        ((r === 'checked' && e.nodeName === 'INPUT') ||
                            (r === 'selected' && e.nodeName === 'OPTION')) &&
                            (e[r] = i)
                    const l = Pe(e, r)
                    i == null || i === !1
                        ? e.removeAttribute(l)
                        : i === !0
                          ? e.setAttribute(l, '')
                          : typeof i == 'string' || typeof i == 'number'
                            ? e.setAttribute(l, i)
                            : e.setAttribute(l, i.toString())
                }
            }
        }
        if (n)
            for (let r in n) {
                const i = n[r]
                if (r !== 'children' && !(r in t)) {
                    r = te(r)
                    const a = Re(r)
                    a
                        ? e.removeEventListener(a[0], i, a[1])
                        : r === 'ref'
                          ? (s = me.get(e)) == null || s()
                          : e.removeAttribute(Pe(e, r))
                }
            }
    },
    Mt = (e, t) => {
        ;(t[C][0] = 0), W.push([e, t])
        const n = t.tag[se] || t.tag,
            s = n.defaultProps ? { ...n.defaultProps, ...t.props } : t.props
        try {
            return [n.call(null, s)]
        } finally {
            W.pop()
        }
    },
    Ge = (e, t, n, s, r) => {
        var i, a
        ;(i = e.vR) != null && i.length && (s.push(...e.vR), delete e.vR),
            typeof e.tag == 'function' &&
                ((a = e[C][1][Ye]) == null || a.forEach((l) => r.push(l))),
            e.vC.forEach((l) => {
                var f
                if (P(l)) n.push(l)
                else if (typeof l.tag == 'function' || l.tag === '') {
                    l.c = t
                    const y = n.length
                    if ((Ge(l, t, n, s, r), l.s)) {
                        for (let d = y; d < n.length; d++) n[d].s = !0
                        l.s = !1
                    }
                } else
                    n.push(l),
                        (f = l.vR) != null &&
                            f.length &&
                            (s.push(...l.vR), delete l.vR)
            })
    },
    Ot = (e) => {
        for (; ; e = e.tag === H || !e.vC || !e.pP ? e.nN : e.vC[0]) {
            if (!e) return null
            if (e.tag !== H && e.e) return e.e
        }
    },
    Je = (e) => {
        var t, n, s, r, i, a
        P(e) ||
            ((n = (t = e[C]) == null ? void 0 : t[1][Ye]) == null ||
                n.forEach((l) => {
                    var f
                    return (f = l[2]) == null ? void 0 : f.call(l)
                }),
            (s = me.get(e.e)) == null || s(),
            e.p === 2 && ((r = e.vC) == null || r.forEach((l) => (l.p = 2))),
            (i = e.vC) == null || i.forEach(Je)),
            e.p || ((a = e.e) == null || a.remove(), delete e.e),
            typeof e.tag == 'function' &&
                (B.delete(e), Y.delete(e), delete e[C][3], (e.a = !0))
    },
    Ee = (e, t, n) => {
        ;(e.c = t), Xe(e, t, n)
    },
    xe = (e, t) => {
        if (t) {
            for (let n = 0, s = e.length; n < s; n++) if (e[n] === t) return n
        }
    },
    Le = Symbol(),
    Xe = (e, t, n) => {
        var y
        const s = [],
            r = [],
            i = []
        Ge(e, t, s, r, i), r.forEach(Je)
        const a = n ? void 0 : t.childNodes
        let l,
            f = null
        if (n) l = -1
        else if (!a.length) l = 0
        else {
            const d = xe(a, Ot(e.nN))
            d !== void 0
                ? ((f = a[d]), (l = d))
                : (l =
                      xe(
                          a,
                          (y = s.find((u) => u.tag !== H && u.e)) == null
                              ? void 0
                              : y.e
                      ) ?? -1),
                l === -1 && (n = !0)
        }
        for (let d = 0, u = s.length; d < u; d++, l++) {
            const o = s[d]
            let c
            if (o.s && o.e) (c = o.e), (o.s = !1)
            else {
                const h = n || !o.e
                P(o)
                    ? (o.e && o.d && (o.e.textContent = o.t),
                      (o.d = !1),
                      (c = o.e || (o.e = document.createTextNode(o.t))))
                    : ((c =
                          o.e ||
                          (o.e = o.n
                              ? document.createElementNS(o.n, o.tag)
                              : document.createElement(o.tag))),
                      Lt(c, o.props, o.pP),
                      Xe(o, c, h))
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
        if ((e.pP && delete e.pP, i.length)) {
            const d = [],
                u = []
            i.forEach(([, o, , c, h]) => {
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
        var i, a, l, f, y, d
        const s = !n && t.pC
        n && (t.pC || (t.pC = t.vC))
        let r
        try {
            n ||
                (n =
                    typeof t.tag == 'function'
                        ? Mt(e, t)
                        : q(t.props.children)),
                ((i = n[0]) == null ? void 0 : i.tag) === '' &&
                    n[0][he] &&
                    ((r = n[0][he]), e[5].push([e, r, t]))
            const u = s ? [...t.pC] : t.vC ? [...t.vC] : void 0,
                o = []
            let c
            for (let h = 0; h < n.length; h++) {
                Array.isArray(n[h]) && n.splice(h, 1, ...n[h].flat())
                let v = Ke(n[h])
                if (v) {
                    typeof v.tag == 'function' &&
                        !v.tag[Be] &&
                        (D.length > 0 &&
                            (v[C][2] = D.map((m) => [m, m.values.at(-1)])),
                        (a = e[5]) != null &&
                            a.length &&
                            (v[C][3] = e[5].at(-1)))
                    let g
                    if (u && u.length) {
                        const m = u.findIndex(
                            P(v)
                                ? (p) => P(p)
                                : v.key !== void 0
                                  ? (p) => p.key === v.key && p.tag === v.tag
                                  : (p) => p.tag === v.tag
                        )
                        m !== -1 && ((g = u[m]), u.splice(m, 1))
                    }
                    if (g)
                        if (P(v))
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
                                            ((f = (l = g.tag)[ht]) != null &&
                                                f.call(l, m, g.props))) &&
                                        (g.s = !0)),
                                (v = g)
                        }
                    else if (!P(v) && _) {
                        const m = I(_)
                        m && (v.n = m)
                    }
                    if (
                        (!P(v) && !v.s && (ne(e, v), delete v.f),
                        o.push(v),
                        c && !c.s && !v.s)
                    )
                        for (
                            let m = c;
                            m && !P(m);
                            m = (y = m.vC) == null ? void 0 : y.at(-1)
                        )
                            m.nN = v
                    c = v
                }
            }
            ;(t.vR = s ? [...t.vC, ...(u || [])] : u || []),
                (t.vC = o),
                s && delete t.pC
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
    Ke = (e) => {
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
                const t = Pt[e.tag]
                t &&
                    (_ || (_ = He('')),
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
    Ve = (e, t, n) => {
        e.c === t && ((e.c = n), e.vC.forEach((s) => Ve(s, t, n)))
    },
    Me = (e, t) => {
        var n, s
        ;(n = t[C][2]) == null ||
            n.forEach(([r, i]) => {
                r.values.push(i)
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
        ;(s = t[C][2]) == null ||
            s.forEach(([r]) => {
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
        let s
        const r = new Promise((i) => (s = i))
        if (
            (B.set(t, [
                s,
                () => {
                    e[2]
                        ? e[2](e, t, (i) => {
                              Me(i, t)
                          }).then(() => s(t))
                        : (Me(e, t), s(t))
                },
            ]),
            Oe.length)
        )
            Oe.at(-1).add(t)
        else {
            await Promise.resolve()
            const i = B.get(t)
            i && (B.delete(t), i[1]())
        }
        return r
    },
    Nt = (e, t) => {
        const n = []
        ;(n[5] = []), (n[4] = !0), ne(n, e, void 0), (n[4] = !1)
        const s = document.createDocumentFragment()
        Ee(e, s, !0), Ve(e, s, t), t.replaceChildren(s)
    },
    jt = (e, t, n) => ({ tag: H, props: { children: e }, key: n, e: t, p: 1 }),
    fe = 0,
    Ye = 1,
    ue = 2,
    de = 3,
    ve = new WeakMap(),
    Qe = (e, t) =>
        !e || !t || e.length !== t.length || t.some((n, s) => n !== e[s]),
    Dt = void 0,
    Ne = [],
    re = (e) => {
        var a
        const t = () => (typeof e == 'function' ? e() : e),
            n = W.at(-1)
        if (!n) return [t(), () => {}]
        const [, s] = n,
            r = (a = s[C][1])[fe] || (a[fe] = []),
            i = s[C][0]++
        return (
            r[i] ||
            (r[i] = [
                t(),
                (l) => {
                    const f = Dt,
                        y = r[i]
                    if (
                        (typeof l == 'function' && (l = l(y[0])),
                        !Object.is(l, y[0]))
                    )
                        if (((y[0] = l), Ne.length)) {
                            const [d, u] = Ne.at(-1)
                            Promise.all([
                                d === 3 ? s : Q([d, !1, f], s),
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
                        } else Q([0, !1, f], s)
                },
            ])
        )
    },
    Ce = (e, t) => {
        var l
        const n = W.at(-1)
        if (!n) return e
        const [, s] = n,
            r = (l = s[C][1])[ue] || (l[ue] = []),
            i = s[C][0]++,
            a = r[i]
        return (
            Qe(a == null ? void 0 : a[1], t) ? (r[i] = [e, t]) : (e = r[i][0]),
            e
        )
    },
    _t = (e) => {
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
    It = (e, t) => {
        var l
        const n = W.at(-1)
        if (!n) return e()
        const [, s] = n,
            r = (l = s[C][1])[de] || (l[de] = []),
            i = s[C][0]++,
            a = r[i]
        return Qe(a == null ? void 0 : a[1], t) && (r[i] = [e(), t]), r[i][0]
    },
    Bt = He({ pending: !1, data: null, method: null, action: null }),
    je = new Set(),
    Ft = (e) => {
        je.add(e), e.finally(() => je.delete(e))
    },
    be = (e, t) =>
        It(
            () => (n) => {
                let s
                e &&
                    (typeof e == 'function'
                        ? (s =
                              e(n) ||
                              (() => {
                                  e(null)
                              }))
                        : e &&
                          'current' in e &&
                          ((e.current = n),
                          (s = () => {
                              e.current = null
                          })))
                const r = t(n)
                return () => {
                    r == null || r(), s == null || s()
                }
            },
            [e]
        ),
    N = Object.create(null),
    X = Object.create(null),
    z = (e, t, n, s, r) => {
        if (t != null && t.itemProp)
            return { tag: e, props: t, type: e, ref: t.ref }
        const i = document.head
        let { onLoad: a, onError: l, precedence: f, blocking: y, ...d } = t,
            u = null,
            o = !1
        const c = K[e]
        let h
        if (c.length > 0) {
            const p = i.querySelectorAll(e)
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
        } else h = i.querySelectorAll(e)
        ;(f = s ? (f ?? '') : void 0), s && (d[V] = f)
        const v = Ce(
                (p) => {
                    if (c.length > 0) {
                        let E = !1
                        for (const S of i.querySelectorAll(e)) {
                            if (E && S.getAttribute(V) !== f) {
                                i.insertBefore(p, S)
                                return
                            }
                            S.getAttribute(V) === f && (E = !0)
                        }
                        i.appendChild(p)
                    } else if (h) {
                        let E = !1
                        for (const S of h)
                            if (S === p) {
                                E = !0
                                break
                            }
                        E ||
                            i.insertBefore(
                                p,
                                i.contains(h[0]) ? h[0] : i.querySelector(e)
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
                    (N[b] = new Promise((R, J) => {
                        p.addEventListener('load', R),
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
                        (N[E] = new Promise((b, R) => {
                            v(u),
                                u.addEventListener('load', b),
                                u.addEventListener('error', R)
                        }))
                _t(S)
            }
        }
        const m = { tag: e, type: e, props: { ...d, ref: g }, ref: g }
        return (m.p = n), u && (m.e = u), jt(m, i)
    },
    Ht = (e) => {
        const t = xt(),
            n = t && I(t)
        return n != null && n.endsWith('svg')
            ? { tag: 'title', props: e, type: 'title', ref: e.ref }
            : z('title', e, void 0, !1, !1)
    },
    Wt = (e) =>
        !e || ['src', 'async'].some((t) => !e[t])
            ? { tag: 'script', props: e, type: 'script', ref: e.ref }
            : z('script', e, 1, !1, !0),
    qt = (e) =>
        !e || !['href', 'precedence'].every((t) => t in e)
            ? { tag: 'style', props: e, type: 'style', ref: e.ref }
            : ((e['data-href'] = e.href),
              delete e.href,
              z('style', e, 2, !0, !0)),
    Ut = (e) =>
        !e ||
        ['onLoad', 'onError'].some((t) => t in e) ||
        (e.rel === 'stylesheet' && (!('precedence' in e) || 'disabled' in e))
            ? { tag: 'link', props: e, type: 'link', ref: e.ref }
            : z('link', e, 1, 'precedence' in e, !0),
    Zt = (e) => z('meta', e, void 0, !1, !1),
    et = Symbol(),
    zt = (e) => {
        const { action: t, ...n } = e
        typeof t != 'function' && (n.action = t)
        const [s, r] = re([null, !1]),
            i = Ce(async (y) => {
                const d = y.isTrusted ? t : y.detail[et]
                if (typeof d != 'function') return
                y.preventDefault()
                const u = new FormData(y.target)
                r([u, !0])
                const o = d(u)
                o instanceof Promise && (Ft(o), await o), r([null, !0])
            }, []),
            a = be(
                e.ref,
                (y) => (
                    y.addEventListener('submit', i),
                    () => {
                        y.removeEventListener('submit', i)
                    }
                )
            ),
            [l, f] = s
        return (
            (s[1] = !1),
            {
                tag: Bt,
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
    tt = (e, { formAction: t, ...n }) => {
        if (typeof t == 'function') {
            const s = Ce((r) => {
                r.preventDefault(),
                    r.currentTarget.form.dispatchEvent(
                        new CustomEvent('submit', { detail: { [et]: t } })
                    )
            }, [])
            n.ref = be(
                n.ref,
                (r) => (
                    r.addEventListener('click', s),
                    () => {
                        r.removeEventListener('click', s)
                    }
                )
            )
        }
        return { tag: e, props: n, type: e, ref: n.ref }
    },
    Gt = (e) => tt('input', e),
    Jt = (e) => tt('button', e)
Object.assign(ye, {
    title: Ht,
    script: Wt,
    style: qt,
    link: Ut,
    meta: Zt,
    form: zt,
    input: Gt,
    button: Jt,
})
new TextEncoder()
var nt = (e, t = {}) => {
        let n
        return (
            Object.keys(t).length > 0 &&
                console.warn('createRoot options are not supported yet'),
            {
                render(s) {
                    if (n === null)
                        throw new Error('Cannot update an unmounted root')
                    n
                        ? n(s)
                        : Nt(
                              Ke({
                                  tag: () => {
                                      const [r, i] = re(s)
                                      return (n = i), r
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
    Xt = (e, t, n = {}) => {
        const s = nt(e, n)
        return s.render(t), s
    },
    G = ':-hono-global',
    Kt = new RegExp(`^${G}{(.*)}$`),
    Vt = 'hono-css',
    O = Symbol(),
    k = Symbol(),
    $ = Symbol(),
    x = Symbol(),
    ie = Symbol(),
    De = Symbol(),
    rt = (e) => {
        let t = 0,
            n = 11
        for (; t < e.length; ) n = (101 * n + e.charCodeAt(t++)) >>> 0
        return 'css-' + n
    },
    Yt = [
        '"(?:(?:\\\\[\\s\\S]|[^"\\\\])*)"',
        "'(?:(?:\\\\[\\s\\S]|[^'\\\\])*)'",
    ].join('|'),
    Qt = new RegExp(
        [
            '(' + Yt + ')',
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
    en = (e) => e.replace(Qt, (t, n, s, r, i) => n || s || r || i || ''),
    st = (e, t) => {
        var a, l
        const n = [],
            s = [],
            r =
                ((a = e[0].match(/^\s*\/\*(.*?)\*\//)) == null
                    ? void 0
                    : a[1]) || ''
        let i = ''
        for (let f = 0, y = e.length; f < y; f++) {
            i += e[f]
            let d = t[f]
            if (!(typeof d == 'boolean' || d === null || d === void 0)) {
                Array.isArray(d) || (d = [d])
                for (let u = 0, o = d.length; u < o; u++) {
                    let c = d[u]
                    if (!(typeof c == 'boolean' || c === null || c === void 0))
                        if (typeof c == 'string')
                            /([\\"'\/])/.test(c)
                                ? (i += c.replace(
                                      new RegExp(`([\\\\"']|(?<=<)\\/)`, 'g'),
                                      '\\$1'
                                  ))
                                : (i += c)
                        else if (typeof c == 'number') i += c
                        else if (c[De]) i += c[De]
                        else if (c[k].startsWith('@keyframes '))
                            n.push(c), (i += ` ${c[k].substring(11)} `)
                        else {
                            if ((l = e[f + 1]) != null && l.match(/^\s*{/))
                                n.push(c), (c = `.${c[k]}`)
                            else {
                                n.push(...c[x]), s.push(...c[ie]), (c = c[$])
                                const h = c.length
                                if (h > 0) {
                                    const v = c[h - 1]
                                    v !== ';' && v !== '}' && (c += ';')
                                }
                            }
                            i += `${c || ''}`
                        }
                }
            }
        }
        return [r, en(i), n, s]
    },
    pe = (e, t) => {
        let [n, s, r, i] = st(e, t)
        const a = Kt.exec(s)
        a && (s = a[1])
        const l = (a ? G : '') + rt(n + s),
            f = (a ? r.map((y) => y[k]) : [l, ...i]).join(' ')
        return { [O]: l, [k]: f, [$]: s, [x]: r, [ie]: i }
    },
    tn = (e) => {
        for (let t = 0, n = e.length; t < n; t++) {
            const s = e[t]
            typeof s == 'string' &&
                (e[t] = { [O]: '', [k]: '', [$]: '', [x]: [], [ie]: [s] })
        }
        return e
    },
    nn = (e, ...t) => {
        const [n, s] = st(e, t)
        return {
            [O]: '',
            [k]: `@keyframes ${rt(n + s)}`,
            [$]: s,
            [x]: [],
            [ie]: [],
        }
    },
    rn = 0,
    sn = (e, t) => {
        e || (e = [`/* h-v-t ${rn++} */`])
        const n = Array.isArray(e) ? pe(e, t) : e,
            s = n[k],
            r = pe(['view-transition-name:', ''], [s])
        return (
            (n[k] = G + n[k]),
            (n[$] = n[$].replace(
                new RegExp('(?<=::view-transition(?:[a-z-]*)\\()(?=\\))', 'g'),
                s
            )),
            (r[k] = r[O] = s),
            (r[x] = [...n[x], n]),
            r
        )
    },
    an = (e) => {
        const t = []
        let n = 0,
            s = 0
        for (let r = 0, i = e.length; r < i; r++) {
            const a = e[r]
            if (a === "'" || a === '"') {
                const l = a
                for (r++; r < i; r++) {
                    if (e[r] === '\\') {
                        r++
                        continue
                    }
                    if (e[r] === l) break
                }
                continue
            }
            if (a === '{') {
                s++
                continue
            }
            if (a === '}') {
                s--, s === 0 && (t.push(e.slice(n, r + 1)), (n = r + 1))
                continue
            }
        }
        return t
    },
    ln = ({ id: e }) => {
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
            s = (a, l) => {
                const [f, y] = n()
                if (!f || !y) {
                    Promise.resolve().then(() => {
                        if (!n()[0]) throw new Error('style sheet not found')
                        s(a, l)
                    })
                    return
                }
                y.has(a) ||
                    (y.add(a),
                    (a.startsWith(G)
                        ? an(l)
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
                        s(a, this[$]),
                        this[x].forEach(({ [k]: l, [$]: f }) => {
                            s(l, f)
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
                        a && (Array.isArray(a) ? a : [a]).map((f) => f[$]),
                },
            }),
        ]
    },
    on = ({ id: e }) => {
        const [t, n] = ln({ id: e }),
            s = new WeakMap(),
            r = new WeakMap(),
            i = new RegExp(
                `(<style id="${e}"(?: nonce="[^"]*")?>.*?)(</style>)`
            ),
            a = (o) => {
                const c = ({ buffer: m, context: p }) => {
                        const [E, S] = s.get(p),
                            b = Object.keys(E)
                        if (!b.length) return
                        let R = ''
                        if (
                            (b.forEach((L) => {
                                ;(S[L] = !0),
                                    (R += L.startsWith(G)
                                        ? E[L]
                                        : `${L[0] === '@' ? '' : '.'}${L}{${E[L]}}`)
                            }),
                            s.set(p, [{}, S]),
                            m && i.test(m[0]))
                        ) {
                            m[0] = m[0].replace(
                                i,
                                (L, at, lt) => `${at}${R}${lt}`
                            )
                            return
                        }
                        const J = r.get(p),
                            ke = `<script${J ? ` nonce="${J}"` : ''}>document.querySelector('#${e}').textContent+=${JSON.stringify(R)}<\/script>`
                        if (m) {
                            m[0] = `${ke}${m[0]}`
                            return
                        }
                        return Promise.resolve(ke)
                    },
                    h = ({ context: m }) => {
                        s.has(m) || s.set(m, [{}, {}])
                        const [p, E] = s.get(m)
                        let S = !0
                        if (
                            (E[o[O]] || ((S = !1), (p[o[O]] = o[$])),
                            o[x].forEach(({ [k]: b, [$]: R }) => {
                                E[b] || ((S = !1), (p[b] = R))
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
            f = (...o) => ((o = tn(o)), l(Array(o.length).fill(''), ...o)),
            y = nn,
            d = (o, ...c) => a(sn(o, c)),
            u = ({ children: o, nonce: c } = {}) =>
                T(
                    `<style id="${e}"${c ? ` nonce="${c}"` : ''}>${o ? o[$] : ''}</style>`,
                    [
                        ({ context: h }) => {
                            r.set(h, c)
                        },
                    ]
                )
        return (
            (u[se] = n),
            { css: l, cx: f, keyframes: y, viewTransition: d, Style: u }
        )
    },
    cn = on({ id: Vt }),
    fn = cn.css
function it() {
    const [e, t] = re(0),
        [n, s] = re()
    return A('section', {
        class: un,
        children: A('div', {
            'content-grid': !0,
            children: [
                A('div', {
                    children: [
                        A('button', {
                            type: 'button',
                            onClick: () => t((r) => r + 1),
                            children: 'Increase count',
                        }),
                        A('span', { children: ['Count: ', e] }),
                    ],
                }),
                A('div', {
                    children: [
                        A('button', {
                            type: 'button',
                            onClick: () => {
                                console.log('Clicked button...')
                            },
                            disabled: !!n,
                            children: 'Fetch message',
                        }),
                        A('span', { children: n }),
                    ],
                }),
            ],
        }),
    })
}
const un = fn`
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
_e && Xt(_e, A(ze, { children: A(it, {}) }))
const Ie = document.getElementById('spa-root')
Ie && nt(Ie).render(A(ze, { children: A(it, {}) }))
