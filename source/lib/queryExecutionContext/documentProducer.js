/*
The MIT License (MIT)
Copyright (c) 2017 Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

"use strict";

var Base = require("../base")
    , DefaultQueryExecutionContext = require("./defaultQueryExecutionContext")
    , HttpHeaders = require("../constants").HttpHeaders
    , HeaderUtils = require("./headerUtils")
    , assert = require("assert")
    , util = require("util");

//SCRIPT START
var DocumentProducer = Base.defineClass(
    /**
     * Provides the Target Partition Range Query Execution Context.
     * @constructor DocumentProducer
     * @param {DocumentClient} documentclient        - The service endpoint to use to create the client.
     * @param {String} collectionLink                - Represents collection link
     * @param {SqlQuerySpec | string} query          - A SQL query.
     * @param {object} targetPartitionKeyRange       - Query Target Partition key Range
     * @ignore
     */
    function (documentclient, collectionLink, query, targetPartitionKeyRange, options) {
        this.documentclient = documentclient;
        this.collectionLink = collectionLink;
        this.query = query;
        this.targetPartitionKeyRange = targetPartitionKeyRange;
        this.itemsBuffer = [];
 
        this.allFetched = false;
        this.err = undefined;

        this.previousContinuationToken = undefined;
        this.continuationToken = undefined;
        this._respHeaders = HeaderUtils.getInitialHeader();

        var isNameBased = Base.isLinkNameBased(collectionLink);
        var path = this.documentclient.getPathFromLink(collectionLink, "docs", isNameBased);
        var id = this.documentclient.getIdFromLink(collectionLink, isNameBased);

        var that = this;
        var fetchFunction = function (options, callback) {
            that.documentclient.queryFeed.call(documentclient,
                documentclient,
                path,
                "docs",
                id,
                function (result) { return result.Documents; },
                function (parent, body) { return body; },
                query,
                options,
                callback,
                that.targetPartitionKeyRange["id"]);
        };
        this.internalExecutionContext = new DefaultQueryExecutionContext(documentclient, query, options, fetchFunction);
    },
    {
        /**
         * Synchronously gives the buffered items if any
         * @returns {Object}       - buffered current items if any
         * @ignore
         */
        peekBufferedItems: function () {
            return this.itemsBuffer;
        },

        /**
         * Synchronously gives the buffered items if any and moves inner indices.
         * @returns {Object}       - buffered current items if any
         * @ignore
         */
        consumeBufferedItems: function () {
            var res = this.itemsBuffer;
            this.itemsBuffer = [];
            this._updateStates(undefined, this.continuationToken === null || this.continuationToken === undefined);
            return res;
        },

        _getAndResetActiveResponseHeaders: function () {
            var ret = this._respHeaders;
            this._respHeaders = HeaderUtils.getInitialHeader();
            return ret;
        },

        _updateStates: function (err, allFetched) {
            if (err) {
                this.err = err
                return;
            }
            if (allFetched) {
                this.allFetched = true;
            }
            if (this.internalExecutionContext.continuation === this.continuationToken) {
                // nothing changed
                return;
            }
            this.previousContinuationToken = this.continuationToken;
            this.continuationToken = this.internalExecutionContext.continuation;
        },

        /**
         * Fetches and bufferes the next page of results and executes the given callback
         * @memberof DocumentProducer
         * @instance
         * @param {callback} callback - Function to execute for next page of result.
         *                              the function takes three parameters error, resources, headerResponse.
        */
        bufferMore: function (callback) {
            var that = this;
            if (that.err) {
                return callback(that.err);
            }

            this.internalExecutionContext.fetchMore(function (err, resources, headerResponse) {
                that._updateStates(err, resources === undefined);
                if (err) {
                    return callback(err, undefined, headerResponse);
                }
                
                if (resources != undefined) {
                    // some more results
                    that.itemsBuffer = that.itemsBuffer.concat(resources);
                } 
                return callback(undefined, resources, headerResponse);
            });
        },

        /**
         * Synchronously gives the bufferend current item if any
         * @returns {Object}       - buffered current item if any
         * @ignore
         */
        getTargetParitionKeyRange: function () {
            return this.targetPartitionKeyRange;
        },

        /**
        * Execute a provided function on the next element in the DocumentProducer.
        * @memberof DocumentProducer
        * @instance
        * @param {callback} callback - Function to execute for each element. the function takes two parameters error, element.
        */
        nextItem: function (callback) {
            var that = this;
            if (that.err) {
                return callback(that.err);
            }
            this.current(function (err, item, headers) {
                if (err) {
                    return callback(err, undefined, headers);
                }

                var extracted = that.itemsBuffer.shift();
                assert.equal(extracted, item);
                callback(undefined, item, headers);
            });
        },

        /**
         * Retrieve the current element on the DocumentProducer.
         * @memberof DocumentProducer
         * @instance
         * @param {callback} callback - Function to execute for the current element. the function takes two parameters error, element.
         */
        current: function (callback) {
            if (this.itemsBuffer.length > 0) {
                return callback(undefined, this.itemsBuffer[0], this._getAndResetActiveResponseHeaders());
            }

            if (this.allFetched) {
                return callback(undefined, undefined, this._getAndResetActiveResponseHeaders());
            }

            var that = this;
            this.bufferMore(function (err, items, headers) {
                if (err) {
                    return callback(err, undefined, headers);
                }

                if (items === undefined) {
                    return callback(undefined, undefined, headers);
                }
                HeaderUtils.mergeHeaders(that._respHeaders, headers);

                that.current(callback);
            });
        },
    },

    {

        /**
         * Provides a Comparator for document producers using the min value of the corresponding target partition.
         * @returns {object}        - Comparator Function
         * @ignore
         */
        createTargetPartitionKeyRangeComparator: function () {
            return function (docProd1, docProd2) {
                var a = docProd1.getTargetParitionKeyRange()['minInclusive'];
                var b = docProd2.getTargetParitionKeyRange()['minInclusive'];
                return (a == b ? 0 : (a > b ? 1 : -1));
            };
        },

        /**
         * Provides a Comparator for document producers which respects orderby sort order.
         * @returns {object}        - Comparator Function
         * @ignore
         */
        createOrderByComparator: function (sortOrder) {
            var comparator = new OrderByDocumentProducerComparator(sortOrder);
            return function (docProd1, docProd2) {
                return comparator.compare(docProd1, docProd2);
            };
        }
    }
);

var OrderByDocumentProducerComparator = Base.defineClass(

    function (sortOrder) {
        this.sortOrder = sortOrder;
        this.targetPartitionKeyRangeDocProdComparator = new DocumentProducer.createTargetPartitionKeyRangeComparator();

        this._typeOrdComparator = Object.freeze({
            NoValue: {
                ord: 0
            },
            undefined: {
                ord: 1
            },
            boolean: {
                ord: 2,
                compFunc: function (a, b) {
                    return (a == b ? 0 : (a > b ? 1 : -1));
                }
            },
            number: {
                ord: 4,
                compFunc: function (a, b) {
                    return (a == b ? 0 : (a > b ? 1 : -1));
                }
            },
            string: {
                ord: 5,
                compFunc: function (a, b) {
                    return (a == b ? 0 : (a > b ? 1 : -1));
                }
            }
        });
    },
    {
        compare: function (docProd1, docProd2) {
            var orderByItemsRes1 = this.getOrderByItems(docProd1.peekBufferedItems()[0]);
            var orderByItemsRes2 = this.getOrderByItems(docProd2.peekBufferedItems()[0]);

            // validate order by items and types
            // TODO: once V1 order by on different types is fixed this need to change
            this.validateOrderByItems(orderByItemsRes1, orderByItemsRes2);

            // no async call in the for loop
            for (var i = 0; i < orderByItemsRes1.length; i++) {
                // compares the orderby items one by one
                var compRes = this.compareOrderByItem(orderByItemsRes1[i], orderByItemsRes2[i]);
                if (compRes !== 0) {
                    if (this.sortOrder[i] === 'Ascending') {
                        return compRes;
                    } else if (this.sortOrder[i] === 'Descending') {
                        return -compRes;
                    }
                }
            }

            return this.targetPartitionKeyRangeDocProdComparator(docProd1, docProd2);
        },

        compareValue: function (item1, type1, item2, type2) {
            var type1Ord = this._typeOrdComparator[type1].ord;
            var type2Ord = this._typeOrdComparator[type2].ord;
            var typeCmp = type1Ord - type2Ord;

            if (typeCmp !== 0) {
                // if the types are different, use type ordinal
                return typeCmp;
            }

            // both are of the same type 
            if ((type1Ord === this._typeOrdComparator['undefined'].ord) || (type1Ord === this._typeOrdComparator['NoValue'].ord)) {
                // if both types are undefined or Null they are equal
                return 0;
            }

            var compFunc = this._typeOrdComparator[type1].compFunc;
            assert.notEqual(compFunc, undefined, "cannot find the comparison function");
            // same type and type is defined compare the items
            return compFunc(item1, item2);
        },

        compareOrderByItem: function (orderByItem1, orderByItem2) {
            var type1 = this.getType(orderByItem1);
            var type2 = this.getType(orderByItem2);
            return this.compareValue(orderByItem1['item'], type1, orderByItem2['item'], type2);
        },

        validateOrderByItems: function (res1, res2) {
            this._throwIf(res1.length != res2.length, util.format("Expected %s, but got %s.", type1, type2));
            this._throwIf(res1.length != this.sortOrder.length, 'orderByItems cannot have a different size than sort orders.');

            for (var i = 0; i < this.sortOrder.length; i++) {
                var type1 = this.getType(res1[i]);
                var type2 = this.getType(res2[i]);
                this._throwIf(type1 !== type2, util.format("Expected %s, but got %s.", type1, type2));
            }
        },

        getType: function (orderByItem) {
            if (!'item' in orderByItem) {
                return 'NoValue';
            }
            var type = typeof (orderByItem['item']);
            this._throwIf(!type in this._typeOrdComparator, util.format("unrecognizable type %s", type));
            return type;
        },

        getOrderByItems: function (res) {
            return res['orderByItems'];
        },

        _throwIf: function (condition, msg) {
            if (condition) {
                throw Error(msg);
            }
        }
    }
);
//SCRIPT END

if (typeof exports !== "undefined") {
    module.exports = DocumentProducer;
    module.exports.OrderByDocumentProducerComparator = OrderByDocumentProducerComparator;
}