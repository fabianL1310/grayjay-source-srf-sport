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

export const getDateString = (date = new Date()) => {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
