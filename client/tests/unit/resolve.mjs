// Lets Node's test runner import app files the way Vite does: without the .js/.jsx extension.
export async function resolve(specifier, context, next) {
    try {
        return await next(specifier, context);
    } catch (error) {
        if (error?.code === 'ERR_MODULE_NOT_FOUND' && /^\.{1,2}\//.test(specifier) && !/\.\w+$/.test(specifier)) {
            for (const ext of ['.js', '.jsx']) {
                try {
                    return await next(specifier + ext, context);
                } catch { /* try the next one */ }
            }
        }
        throw error;
    }
}
