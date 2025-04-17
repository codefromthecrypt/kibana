/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import expect from '@kbn/expect';
import type { Ecs, EcsHost } from '@elastic/ecs';
import type {
  IndexRequest,
  SearchHit,
  SearchTotalHits,
} from '@elastic/elasticsearch/lib/api/types';
import { FtrProviderContext } from '@kbn/ftr-common-functional-services';
import type { GetEntityStoreStatusResponse } from '@kbn/security-solution-plugin/common/api/entity_analytics/entity_store/status.gen';
import { dataViewRouteHelpersFactory } from '../../utils/data_view';
import { EntityStoreUtils } from '../../utils';

const DATASTREAM_NAME: string = 'logs-elastic_agent.cloudbeat-test';
const HOST_TRANSFORM_ID: string = 'entities-v1-latest-security_host_default';
const INDEX_NAME: string = '.entities.v1.latest.security_host_default';
const TIMEOUT_MS: number = 300000; // 5 minutes

export default function (providerContext: FtrProviderContext) {
  const supertest = providerContext.getService('supertest');
  const retry = providerContext.getService('retry');
  const es = providerContext.getService('es');
  const dataView = dataViewRouteHelpersFactory(supertest);
  const utils = EntityStoreUtils(providerContext.getService);

  describe('@ess Host transform logic', () => {
    describe('Entity Store is not installed by default', () => {
      it("Should return 200 and status 'not_installed'", async () => {
        const { body } = await supertest.get('/api/entity_store/status').expect(200);

        const response: GetEntityStoreStatusResponse = body as GetEntityStoreStatusResponse;
        expect(response.status).to.eql('not_installed');
      });
    });

    describe('Install Entity Store and test Host transform', () => {
      before(async () => {
        await utils.cleanEngines();
        // Initialize security solution by creating a prerequisite index pattern.
        // Helps avoid "Error initializing entity store: Data view not found 'security-solution-default'"
        await dataView.create('security-solution');
        // Create a test index matching transform's pattern to store test documents
        await es.indices.createDataStream({ name: DATASTREAM_NAME });
      });

      after(async () => {
        await es.indices.deleteDataStream({ name: DATASTREAM_NAME });
        await dataView.delete('security-solution');
      });

      beforeEach(async () => {
        // Now we can enable the Entity Store...
        const response = await supertest
          .post('/api/entity_store/enable')
          .set('kbn-xsrf', 'xxxx')
          .send({});
        expect(response.statusCode).to.eql(200);
        expect(response.body.succeeded).to.eql(true);

        // and wait for it to start up
        await retry.waitForWithTimeout('Entity Store to initialize', TIMEOUT_MS, async () => {
          const { body } = await supertest
            .get('/api/entity_store/status')
            .query({ include_components: true })
            .expect(200);
          expect(body.status).to.eql('running');
          return true;
        });
      });

      afterEach(async () => {
        await utils.cleanEngines();
      });

      it("Should return 200 and status 'running' for all engines", async () => {
        const { body } = await supertest
          .get('/api/entity_store/status')
          .query({ include_components: true })
          .expect(200);

        const response: GetEntityStoreStatusResponse = body as GetEntityStoreStatusResponse;
        expect(response.status).to.eql('running');
        for (const engine of response.engines) {
          expect(engine.status).to.eql('started');
          if (!engine.components) {
            continue;
          }
          for (const component of engine.components) {
            expect(component.installed).to.be(true);
          }
        }
      });

      it('Should successfully trigger a host transform', async () => {
        const HOST_NAME: string = 'host-transform-test-ip';
        const IPs: string[] = ['1.1.1.1', '2.2.2.2'];
        const { count, transforms } = await es.transform.getTransformStats({
          transform_id: HOST_TRANSFORM_ID,
        });
        expect(count).to.eql(1);
        let transform = transforms[0];
        expect(transform.id).to.eql(HOST_TRANSFORM_ID);
        const triggerCount: number = transform.stats.trigger_count;
        const docsProcessed: number = transform.stats.documents_processed;

        // Create two documents with the same host.name, different IPs
        for (const ip of IPs) {
          const { result } = await es.index(buildHostTransformDocument(HOST_NAME, { ip }));
          expect(result).to.eql('created');
        }

        // Trigger the transform manually
        const { acknowledged } = await es.transform.scheduleNowTransform({
          transform_id: HOST_TRANSFORM_ID,
        });
        expect(acknowledged).to.be(true);

        await retry.waitForWithTimeout('Transform to run again', TIMEOUT_MS, async () => {
          const response = await es.transform.getTransformStats({
            transform_id: HOST_TRANSFORM_ID,
          });
          transform = response.transforms[0];
          expect(transform.stats.trigger_count).to.greaterThan(triggerCount);
          expect(transform.stats.documents_processed).to.greaterThan(docsProcessed);
          return true;
        });

        await retry.waitForWithTimeout(
          'Document to be processed and transformed',
          TIMEOUT_MS,
          async () => {
            const result = await es.search({
              index: INDEX_NAME,
              query: {
                term: {
                  'host.name': HOST_NAME,
                },
              },
            });
            const total = result.hits.total as SearchTotalHits;
            expect(total.value).to.eql(1);
            const hit = result.hits.hits[0] as SearchHit<Ecs>;
            expect(hit._source).ok();
            expect(hit._source?.host?.name).to.eql(HOST_NAME);
            expect(hit._source?.host?.ip).to.eql(IPs);

            return true;
          }
        );
      });


      it('Should successfully collect all expected fields', async () => {
        const HOST_NAME: string = 'host-transform-test-ip';
        const DOMAIN: string[] = ['example.com', 'sub.example.com'];
        const HOST_HOSTNAME: string[] = ['example.com', 'example.com'];
        const IDs: string[] = ['alpha', 'beta'];
        const OS_NAMES: string = ['ubuntu', 'macos'];
        const OS_TYPES: string = ['linux', 'darwin'];
        const MAC: string = ['abc', 'def'];
        const ARCH: string = ['x86-64', 'arm64'];
        const IPs: string[] = ['1.1.1.1', '2.2.2.2'];
        const { count, transforms } = await es.transform.getTransformStats({
          transform_id: HOST_TRANSFORM_ID,
        });
        expect(count).to.eql(1);
        let transform = transforms[0];
        expect(transform.id).to.eql(HOST_TRANSFORM_ID);
        const triggerCount: number = transform.stats.trigger_count;
        const docsProcessed: number = transform.stats.documents_processed;

        // Create two documents with the same host.name, different IPs
        for (let i = 0; i < 2; i++) {
          const { result } = await es.index(
            buildHostTransformDocument(HOST_NAME, {
              domain: DOMAIN[i],
              hostname: HOST_HOSTNAME[i],
              id: IDs[i],
              os: {
                name: OS_NAMES[i],
                type: OS_TYPES[i],
              },
              mac: MAC[i],
              architecture: ARCH[i],
              ip: IPs[i],
            }),
          );
          expect(result).to.eql('created');
        }

        // Trigger the transform manually
        const { acknowledged } = await es.transform.scheduleNowTransform({
          transform_id: HOST_TRANSFORM_ID,
        });
        expect(acknowledged).to.be(true);

        await retry.waitForWithTimeout('Transform to run again', TIMEOUT_MS, async () => {
          const response = await es.transform.getTransformStats({
            transform_id: HOST_TRANSFORM_ID,
          });
          transform = response.transforms[0];
          expect(transform.stats.trigger_count).to.greaterThan(triggerCount);
          expect(transform.stats.documents_processed).to.greaterThan(docsProcessed);
          return true;
        });

        await retry.waitForWithTimeout(
          'Document to be processed and transformed',
          TIMEOUT_MS,
          async () => {
            const result = await es.search({
              index: INDEX_NAME,
              query: {
                term: {
                  'host.name': HOST_NAME,
                },
              },
            });
            const total = result.hits.total as SearchTotalHits;
            expect(total.value).to.eql(1);
            const hit = result.hits.hits[0] as SearchHit<Ecs>;
            expect(hit._source).ok();

            expect(hit._source?.host?.name).to.eql(HOST_NAME);
            expectFieldToEqualValues(hit._source?.host?.domain, DOMAIN);
            expectFieldToEqualValues(hit._source?.host?.domain, DOMAIN);
            expectFieldToEqualValues(hit._source?.host?.hostname, ['example.com']);
            expectFieldToEqualValues(hit._source?.host?.id, IDs);
            expectFieldToEqualValues(hit._source?.host?.os?.name, OS_NAMES);
            expectFieldToEqualValues(hit._source?.host?.os?.type, OS_TYPES);
            expectFieldToEqualValues(hit._source?.host?.ip, IPs);
            expectFieldToEqualValues(hit._source?.host?.mac, MAC);
            expectFieldToEqualValues(hit._source?.host?.architecture, ARCH);

            return true;
          }
        );
      });

    });
  });
}

function expectFieldToEqualValues(field: string[], values: string[]) {
  expect(field.length).to.eql(values.length)
  const sortedField: string[] = field.sort((a, b) => a > b ? 1 : -1);
  const sortedValues: string[] = values.sort((a, b) => a > b ? 1 : -1);
  for (let i = 0; i < sortedField.length; i++)  {
    expect(sortedField[i]).to.eql(sortedValues[i]);
  }
}

function buildHostTransformDocument(name: string, host: EcsHost): IndexRequest {
  host.name = name;
  // Get timestamp without the millisecond part
  const isoTimestamp: string = new Date().toISOString().split('.')[0];
  const document: IndexRequest = {
    index: DATASTREAM_NAME,
    document: {
      '@timestamp': isoTimestamp,
      host,
    },
  };
  return document;
}
