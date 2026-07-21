import { getSportPageUrl, getSportUrl, PLATFORM } from "./constants";
import { batchFetchJson, fetchJson } from "./helpers";
import { getConfig } from "./state";
import { Author } from "./types/author.types";

export const getAuthors = (keys: string[]) => {
    const icons = getSportIconUrls(keys);
    // TODO maybe use the url without sports key which returns all sports at once. But only key and name, which should be sufficient
    const sports = batchFetchJson<Author>(
        keys.map((key) => getSportUrl({ sportKey: key })),
    )
        .reduce((acc, { body: sport }) => {
            sport.iconUrl = icons[sport.key];
            acc[sport.key] = sport;
            return acc;
        }, {} as Record<string, Author>);

    const configId = getConfig("id");
    return keys.reduce(
        (acc, key) => {
            const sport = sports[key];
            if (!sport) return acc;
            acc[key] = new PlatformAuthorLink(
                new PlatformID(PLATFORM, sport.key, configId),
                // TODO use language set in settings
                sport.name.de,
                getSportPageUrl(sport.key),
                sport.iconUrl,
            );
            return acc;
        },
        {} as Record<string, PlatformAuthorLink>,
    );
};

const getSportIconUrls = (sportKeys: string[]) => {
    const sourceUrl = getConfig<string>("sourceUrl");
    const baseUrl = `${sourceUrl.slice(0, sourceUrl.lastIndexOf("/"))}/dist/icons/`;

    const responses = batchFetchJson(
        sportKeys.map((key) => new URL(`${baseUrl}${key}.png`)),
        "HEAD",
    );

    return responses.reduce((acc, response, index) => {
        if (response.isOk) {
            acc[sportKeys[index]] = `${baseUrl}${sportKeys[index]}.png`;
        }
        return acc;
    }, {} as Record<string, string>);
};

export const getSportIdByKey = (key: string): string => {
    const sports = fetchJson<{
        id: string;
        key: string;
        }[]>(
        getSportUrl({
            language: null,
        }),
    );

    const sport = sports.find((s) => s.key === key);
    if (!sport) {
        throw new Error(`Sport with key ${key} not found`);
    }

    return sport.id;
};
