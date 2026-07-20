import type { BatchHttpResponse } from "./types/http.types";

export const fetchJson = <T = any>(url: URL): T => {
    const response = http.GET(url.toString(), {}, false);
    if (!response.isOk) {
        throw new ScriptException(
            "Request failed (" + response.code + "): " + url,
        );
    }
    try {
        return JSON.parse(response.body);
    } catch (e) {
        throw new ScriptException("Invalid JSON from " + url + ": " + e);
    }
};

export const batchFetchJson = <T = any>(
    urls: URL[],
    method: "GET" | "HEAD" = "GET",
): BatchHttpResponse<T>[] => {
    const batch = urls.reduce(
        (batch, url) => batch.request(method, url.toString(), {}, false),
        http.batch(),
    );
    const responses = batch.execute();

    return responses.map((response, i) => {
        if (method === "HEAD") {
            return response as BatchHttpResponse<T>;
        }

        try {
            return {
                ...response,
                body: JSON.parse(response.body) as T,
            };
        } catch (e) {
            throw new ScriptException(
                "Invalid JSON from " + urls[i] + ": " + e,
            );
        }
    });
};

export const getDateString = (date = new Date()) => {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
