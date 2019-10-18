import { Datastore, Transaction } from '@google-cloud/datastore';
import { entity as Entity } from '@google-cloud/datastore/build/src/entity';
import { OrderOptions, RunQueryInfo } from '@google-cloud/datastore/build/src/query';
import * as trace from '@google-cloud/trace-agent';
import * as Logger from 'bunyan';
import * as DataLoader from 'dataloader';
import * as _ from 'lodash';
import { createLogger } from '../gcloud/logging';
import { asArray, OneOrMany } from '../util/types';
import { Context } from './context';
import { buildFilters, Filters } from './filters';

const keysEqual = (key1: Entity.Key, key2: Entity.Key) => {
  return _.isEqual(key1.path, key2.path);
};

const countEntities = (keys: Entity.Key[]) => {
  const result = keys.reduce<Record<string, number>>((prev, current) => {
    if (!prev[current.kind]) {
      prev[current.kind] = 1;
    } else {
      prev[current.kind] += 1;
    }

    return prev;
  }, {});

  return Object.entries(result)
    .map(([entry, value]) => `${entry}: ${value} entities`)
    .join(', ');
};

export type Index<T> = true | { [K in keyof T]?: T[K] extends Array<any> ? Index<T[K][0]> : Index<T[K]> };

export interface QueryOptions<T> {
  select: OneOrMany<keyof T & string>;
  filters: Filters<T>;
  sort: {
    property: keyof T & string;
    options?: OrderOptions;
  };
  groupBy: OneOrMany<keyof T & string>;
  start: string;
  end: string;
  hasAnscestor: Entity.Key;
  offset: number;
  limit: number;
}
export interface DatastorePayload<T> {
  key: Entity.Key;
  data: T | object;
  excludeFromIndexes?: string[];
}

export type WithDatstoreKey<T> = T & {
  [Entity.KEY_SYMBOL]: Entity.Key;
};

function isTransaction(datastore: Datastore | Transaction): datastore is Transaction {
  return (datastore as any).commit !== undefined;
}

export class DatastoreLoader {
  private readonly loader: DataLoader<Entity.Key, object>;
  private readonly datastore: Datastore | Transaction;
  private readonly parentContext: Context;
  private readonly logger: Logger;

  constructor(datastore: Datastore | Transaction, context: Context) {
    this.datastore = datastore;
    this.loader = new DataLoader(this.load, {
      cacheKeyFn: (key: Entity.Key) => key.path.join(':'),
    });
    this.parentContext = context;
    this.logger = createLogger('loader');
  }

  public async get(id: Entity.Key[]): Promise<object[]> {
    return await this.loader.loadMany(id);
  }

  /**
   * Persist a set of entities in datastore
   *
   * This method will automatically batch them in groups of 100
   *
   * @param entities The entities to persist
   */
  public async save(entities: ReadonlyArray<DatastorePayload<any>>): Promise<void> {
    await this.applyBatched(
      entities,
      (datastore, chunk) => datastore.save(chunk),
      (loader, { key, data }) => loader.prime(key, data),
    );
  }

  public async delete(entities: ReadonlyArray<Entity.Key>): Promise<void> {
    await this.applyBatched(
      entities,
      (datastore, chunk) => datastore.delete(chunk) as Promise<any>,
      (loader, key) => loader.clear(key),
    );
  }

  public async update(entities: ReadonlyArray<DatastorePayload<any>>): Promise<void> {
    await this.applyBatched(
      entities,
      (datastore, chunk) => datastore.save(chunk),
      (loader, { key, data }) => loader.prime(key, data),
    );
  }

  public async upsert(entities: ReadonlyArray<DatastorePayload<any>>): Promise<void> {
    await this.applyBatched(
      entities,
      (datastore, chunk) => datastore.upsert(chunk),
      (loader, { key, data }) => loader.prime(key, data),
    );
  }

  public async insert(entities: ReadonlyArray<DatastorePayload<any>>): Promise<void> {
    await this.applyBatched(
      entities,
      (datastore, chunk) => datastore.insert(chunk),
      (loader, { key, data }) => loader.prime(key, data),
    );
  }

  public async executeQuery<T>(
    kind: string,
    options: Partial<QueryOptions<T>>,
  ): Promise<[WithDatstoreKey<T>[], RunQueryInfo]> {
    let query = this.datastore.createQuery(kind);

    if (options.select) {
      query = query.select(asArray(options.select));
    }

    if (options.filters) {
      query = buildFilters(query, options.filters);
    }

    if (options.sort) {
      query.order(options.sort.property, options.sort.options);
    }

    if (options.groupBy) {
      query.groupBy(asArray(options.groupBy));
    }

    if (options.start) {
      query.start(options.start);
    }

    if (options.end) {
      query.end(options.end);
    }

    if (options.hasAnscestor) {
      query.hasAncestor(options.hasAnscestor);
    }

    if (options.limit) {
      query.limit(options.limit);
    }

    if (options.offset) {
      query.offset(options.offset);
    }

    const [results, queryInfo] = await query.run();

    results.forEach((result: any) => {
      this.loader.prime(result[Datastore.KEY], _.omit(result, Datastore.KEY));
    });

    return [results as WithDatstoreKey<T>[], queryInfo];
  }

  public async inTransaction<T>(callback: (tx: Context) => Promise<T>): Promise<T> {
    if (isTransaction(this.datastore)) {
      return await callback({
        ...this.parentContext,
        datastore: this,
      });
    } else {
      const transaction = this.datastore.transaction();
      await transaction.run();

      try {
        const result = await callback({
          ...this.parentContext,
          datastore: new DatastoreLoader(transaction, this.parentContext),
        });

        await transaction.commit();

        return result;
      } catch (ex) {
        this.logger.error('Rolling back transaction - error encountered', ex);
        await transaction.rollback();
        throw ex;
      }
    }
  }

  private async applyBatched<T>(
    values: ReadonlyArray<T>,
    operation: (datastore: Datastore | Transaction, chunk: ReadonlyArray<T>) => Promise<any>,
    updateLoader: (loader: DataLoader<Entity.Key, {}>, value: T) => void,
    batchSize: number = 100,
  ) {
    const entityChunks: T[][] = _.chunk(values, batchSize);
    const pendingModifications = entityChunks.map((chunk: T[]) => operation(this.datastore, chunk));
    await Promise.all(pendingModifications);

    values.forEach(value => updateLoader(this.loader, value));
  }

  private load = async (keys: Entity.Key[]): Promise<Array<any | Error>> => {
    const span = trace.get().createChildSpan({
      name: 'load-keys',
    });
    const prettyPrint = countEntities(keys);
    span.addLabel('entities', prettyPrint);

    const [results] = await this.datastore.get(keys);
    span.endSpan();
    this.logger.debug('Fetched entities by key ', { entities: prettyPrint });

    return keys.map(key => results.find((result: any) => keysEqual(result[Datastore.KEY], key)));
  };
}
