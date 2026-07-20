export interface BatchHttpResponse<T> {
  url: string;
  code: number;
  headers: HttpHeaders;
  body: T;
  isOk: boolean;
}
