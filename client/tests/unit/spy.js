/** Minimal call recorder for tests: const fn = spy(impl); fn.calls -> [[args...], ...] */
export function spy(impl = () => undefined) {
    const fn = (...args) => {
        fn.calls.push(args);
        return impl(...args);
    };
    fn.calls = [];
    return fn;
}
