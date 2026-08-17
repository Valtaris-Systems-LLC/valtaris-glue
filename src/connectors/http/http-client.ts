// src/connectors/http/http-client.ts
// Valtaris Glue — HTTP Connector
//
// Provides a simple HTTP client for workflow tasks:
// - GET
// - POST
// - PUT
// - DELETE
//
// This is the foundation for external API calls.

import axios, { AxiosRequestConfig } from "axios";

export class HttpClient {
  async get(url: string, config?: AxiosRequestConfig) {
    return await axios.get(url, config).then((r) => r.data);
  }

  async post(url: string, body?: any, config?: AxiosRequestConfig) {
    return await axios.post(url, body, config).then((r) => r.data);
  }

  async put(url: string, body?: any, config?: AxiosRequestConfig) {
    return await axios.put(url, body, config).then((r) => r.data);
  }

  async delete(url: string, config?: AxiosRequestConfig) {
    return await axios.delete(url, config).then((r) => r.data);
  }
}
