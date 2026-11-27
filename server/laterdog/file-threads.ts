process.env.UV_THREADPOOL_SIZE ??= "16";

export const fileThreads = Number(process.env.UV_THREADPOOL_SIZE);
