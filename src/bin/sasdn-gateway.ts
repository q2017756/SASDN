import * as LibFs from 'mz/fs';
import * as program from 'commander';
import * as LibPath from 'path';
import {
    BodyParameter,
    Operation,
    Path,
    PathParameter,
    QueryParameter,
    Spec as SwaggerSpec
} from 'swagger-schema-official';
import {
    GatewaySwaggerSchema,
    lcfirst,
    mkdir,
    addIntoRpcMethodImportPathInfos,
    parseMsgNamesFromProto,
    parseProto,
    Proto,
    ProtoFile,
    ProtoParseResult,
    ProtoMsgImportInfos,
    readProtoList,
    readSwaggerList,
    RpcMethodImportPathInfos,
    Swagger,
    ucfirst
} from './lib/lib';
import {TplEngine} from './lib/template';

const pkg = require('../../package.json');

interface GatewayInfo {
    apiName: string;
    serviceName: string;
    fileName: string;
    packageName: string;
    method: string;
    uri: string;
    protoMsgImportPath: RpcMethodImportPathInfos;
    funcParamsStr: string;
    aggParamsStr: string;
    requiredParamsStr: string;
    requestTypeStr: string;
    requestParameters: Array<GatewaySwaggerSchema>;
    responseTypeStr: string;
    responseParameters: Array<GatewaySwaggerSchema>;
}

interface GatewayDefinitionSchemaMap {
    [definitionName: string]: Array<GatewaySwaggerSchema>;
}

program.version(pkg.version)
    .option('-p, --proto <dir>', 'directory of proto files')
    .option('-s, --swagger <dir>', 'directory of swagger spec files')
    .option('-o, --output <dir>', 'directory to output service codes')
    .option('-i, --import <items>', 'third party proto import path: e.g path1,path2,path3', function list(val) {
        return val.split(',');
    })
    .option('-d, --deepSearchLevel <number>', 'add -d to parse swagger definition depth, default: 5')
    .option('-c, --client', 'add -c to output API Gateway client codes')
    .parse(process.argv);

const PROTO_DIR = (program as any).proto === undefined ? undefined : LibPath.normalize((program as any).proto);
const SWAGGER_DIR = (program as any).swagger === undefined ? undefined : LibPath.normalize((program as any).swagger);
const OUTPUT_DIR = (program as any).output === undefined ? undefined : LibPath.normalize((program as any).output);
const IMPORTS = (program as any).import === undefined ? [] : (program as any).import;
const DEEP_SEARCH_LEVEL = (program as any).deepSearchLevel === undefined ? 5 : (program as any).deepSearchLevel;
const API_GATEWAY_CLIENT = (program as any).client !== undefined;
const METHOD_OPTIONS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'];

class GatewayCLI {
    private _protoFiles: Array<ProtoFile> = [];
    private _swaggerList: Array<SwaggerSpec> = [];
    private _protoMsgImportInfos: ProtoMsgImportInfos = {};

    static instance() {
        return new GatewayCLI();
    }

    public async run() {
        console.log('GatewayCLI start.');
        await this._validate();
        await this._loadProtos();
        await this._loadSpecs();
        await this._genSpecs();
    }

    private async _validate() {
        console.log('GatewayCLI validate.');

        if (!PROTO_DIR) {
            throw new Error('--proto is required');
        }
        if (!SWAGGER_DIR) {
            throw new Error('--swagger is required');
        }
        if (!OUTPUT_DIR) {
            throw new Error('--output is required');
        }
        let protoStat = await LibFs.stat(PROTO_DIR);
        if (!protoStat.isDirectory()) {
            throw new Error('--proto is not a directory');
        }
        let swaggerStat = await LibFs.stat(SWAGGER_DIR);
        if (!swaggerStat.isDirectory()) {
            throw new Error('--swagger is not a directory');
        }
        let outputStat = await LibFs.stat(OUTPUT_DIR);
        if (!outputStat.isDirectory()) {
            throw new Error('--output is not a directory');
        }
    }

    private async _loadProtos() {
        console.log('ServiceCLI load result files.');

        this._protoFiles = await readProtoList(PROTO_DIR, OUTPUT_DIR);
        if (IMPORTS.length > 0) {
            for (let i = 0; i < IMPORTS.length; i++) {
                this._protoFiles = this._protoFiles.concat(await readProtoList(LibPath.normalize(IMPORTS[i]), OUTPUT_DIR));
            }
        }
        if (this._protoFiles.length === 0) {
            throw new Error('no proto files found');
        }
    }

    private async _loadSpecs() {
        console.log('GatewayCLI load swagger spec files.');

        this._swaggerList = await readSwaggerList(SWAGGER_DIR, OUTPUT_DIR);
        if (this._swaggerList.length === 0) {
            throw new Error('no valid swagger spec json found');
        }
    }

    private async _genSpecs() {
        console.log('GatewayCLI generate router api codes.');

        // 从 proto 文件中解析出 ProtobufIParserResult 数据
        let parseResults = [] as Array<ProtoParseResult>;
        for (let i = 0; i < this._protoFiles.length; i++) {
            let protoFile = this._protoFiles[i];
            if (!protoFile) {
                continue;
            }
            let parseResult = {} as ProtoParseResult;
            parseResult.result = await parseProto(protoFile);
            parseResult.protoFile = protoFile;
            parseResults.push(parseResult);

            let msgImportInfos = parseMsgNamesFromProto(parseResult.result, protoFile, '');
            for (let msgTypeStr in msgImportInfos) {
                this._protoMsgImportInfos[msgTypeStr] = msgImportInfos[msgTypeStr];
            }
        }

        let gatewayInfoList = [] as Array<GatewayInfo>;

        for (let swaggerSpec of this._swaggerList) {
            console.log(`GatewayCLI generate swagger spec: ${swaggerSpec.info.title}`);

            // Parse swagger definitions schema to ${Array<GatewaySwaggerSchema>}
            let gatewayDefinitionSchemaMap = {} as GatewayDefinitionSchemaMap;
            for (let definitionName in swaggerSpec.definitions) {
                gatewayDefinitionSchemaMap[definitionName] = Swagger.parseSwaggerDefinitionMap(swaggerSpec.definitions, definitionName, 1, DEEP_SEARCH_LEVEL);
            }

            // Loop paths uri
            for (let pathName in swaggerSpec.paths) {
                let swaggerPath = swaggerSpec.paths[pathName] as Path;

                // method: GET, PUT, POST, DELETE, OPTIONS, HEAD, PATCH
                for (let method in swaggerPath) {

                    // not a method operation
                    if (METHOD_OPTIONS.indexOf(method) < 0) {
                        continue;
                    }

                    // read method operation
                    let methodOperation = swaggerPath[method] as Operation;
                    let protoMsgImportPaths = {} as RpcMethodImportPathInfos;

                    // loop method parameters
                    let swaggerSchemaList = [] as Array<GatewaySwaggerSchema>;

                    // responseType handler
                    let responseType = Swagger.getRefName(methodOperation.responses[200].schema.$ref);
                    let responseParameters = gatewayDefinitionSchemaMap[responseType];

                    if (this._protoMsgImportInfos.hasOwnProperty(responseType)) {
                        let protoMsgImportInfo = this._protoMsgImportInfos[responseType];
                        responseType = protoMsgImportInfo.msgType;
                        protoMsgImportPaths = addIntoRpcMethodImportPathInfos(
                            protoMsgImportPaths,
                            responseType,
                            Proto.genProtoMsgImportPathViaRouterPath(
                                protoMsgImportInfo.protoFile,
                                Proto.genFullOutputRouterApiPath(protoMsgImportInfo.protoFile)
                            ).replace(/\\/g, '/')
                        );
                    }

                    let requestType: string = '';
                    let funcParamsStr: string = '';
                    let aggParamsStr: string = '';
                    let requiredParamsStr: string = '';

                    // 循环解析 parameters 字段，并将字段类型和 schema 结构加入到 swaggerSchemaList。
                    for (let parameter of methodOperation.parameters) {

                        let type: string;
                        let schema: Array<GatewaySwaggerSchema> = [];

                        switch (parameter.in) {
                            case 'body':
                                let definitionName = Swagger.getRefName((parameter as BodyParameter).schema.$ref);
                                type = 'object';
                                schema = gatewayDefinitionSchemaMap[definitionName];

                                if (this._protoMsgImportInfos.hasOwnProperty(definitionName)) {
                                    let protoMsgImportInfo = this._protoMsgImportInfos[definitionName];
                                    requestType = protoMsgImportInfo.msgType;
                                    protoMsgImportPaths = addIntoRpcMethodImportPathInfos(
                                        protoMsgImportPaths,
                                        requestType as string,
                                        Proto.genProtoMsgImportPathViaRouterPath(
                                            protoMsgImportInfo.protoFile,
                                            Proto.genFullOutputRouterApiPath(protoMsgImportInfo.protoFile)
                                        ).replace(/\\/g, '/')
                                    );
                                }

                                break;
                            case 'query':
                            case 'path':
                                type = (parameter as QueryParameter | PathParameter).type;
                                break;
                            default:
                                type = 'any'; // headParameter, formDataParameter
                                break;
                        }

                        let swaggerSchema: GatewaySwaggerSchema = {
                            name: parameter.name,
                            required: parameter.required,
                            type: type,
                        };

                        if (schema.length > 0) {
                            swaggerSchema.schema = schema;
                        }

                        swaggerSchemaList.push(swaggerSchema);

                        funcParamsStr += (funcParamsStr === '') ? parameter.name : `, ${parameter.name}`;
                        aggParamsStr += (aggParamsStr === '') ? `'${parameter.name}'` : `, '${parameter.name}'`;

                        if (parameter.required) {
                            requiredParamsStr += (requiredParamsStr == '') ? `'${parameter.name}'` : `, '${parameter.name}'`;
                        }
                    }

                    // 循环解析 response 的 definitions 数据，将需要 import 的文件和类名加入到 RpcMethodImportPathInfos 列表数据中。
                    for (let i in responseParameters) {
                        const responseParameter = responseParameters[i] as GatewaySwaggerSchema;

                        if (responseParameter.hasOwnProperty('$ref')
                            || (responseParameter.protoArray && responseParameter.protoArray.hasOwnProperty('$ref'))
                            || (responseParameter.protoMap && responseParameter.protoMap.hasOwnProperty('$ref'))) {

                            let definitionName: string;
                            if (responseParameter.protoArray && responseParameter.protoArray.hasOwnProperty('$ref')) {
                                definitionName = Swagger.getRefName(responseParameter.protoArray['$ref']);
                            } else if (responseParameter.protoMap && responseParameter.protoMap.hasOwnProperty('$ref')) {
                                definitionName = Swagger.getRefName(responseParameter.protoMap['$ref']);
                            } else {
                                definitionName = Swagger.getRefName(responseParameter['$ref']);
                            }

                            if (this._protoMsgImportInfos.hasOwnProperty(definitionName)) {
                                let protoMsgImportInfo = this._protoMsgImportInfos[definitionName];
                                if (responseParameter.protoArray && responseParameter.protoArray.hasOwnProperty('$ref')) {
                                    responseParameter.protoArray['$ref'] = protoMsgImportInfo.msgType;
                                } else if (responseParameter.protoMap && responseParameter.protoMap.hasOwnProperty('$ref')) {
                                    responseParameter.protoMap['$ref'] = protoMsgImportInfo.msgType;
                                } else {
                                    responseParameter['$ref'] = protoMsgImportInfo.msgType;
                                }

                                protoMsgImportPaths = addIntoRpcMethodImportPathInfos(
                                    protoMsgImportPaths,
                                    protoMsgImportInfo.msgType,
                                    Proto.genProtoMsgImportPathViaRouterPath(
                                        protoMsgImportInfo.protoFile,
                                        Proto.genFullOutputRouterApiPath(protoMsgImportInfo.protoFile)
                                    ).replace(/\\/g, '/')
                                );
                            }
                        }

                        responseParameters[i] = responseParameter;
                    }

                    gatewayInfoList.push({
                        apiName: ucfirst(method) + methodOperation.operationId,
                        serviceName: methodOperation.tags[0],
                        fileName: lcfirst(method) + methodOperation.operationId,
                        packageName: swaggerSpec.info.title.split('/')[0],
                        method: method,
                        uri: Swagger.convertSwaggerUriToKoaUri(pathName),
                        protoMsgImportPath: protoMsgImportPaths,
                        funcParamsStr: funcParamsStr,
                        aggParamsStr: aggParamsStr,
                        requiredParamsStr: requiredParamsStr,
                        requestTypeStr: requestType,
                        requestParameters: swaggerSchemaList,
                        responseTypeStr: responseType,
                        responseParameters: responseParameters,
                    });
                }
            }

            // make router dir in OUTPUT_DIR
            await mkdir(LibPath.join(OUTPUT_DIR, 'router'));

            // TplEngine RegisterHelper
            TplEngine.registerHelper('lcfirst', lcfirst);
            TplEngine.registerHelper('equal', function (v1, v2, options) {
                if (v1 === v2) {
                    return options.fn(this);
                } else {
                    return options.inverse(this);
                }
            });
            TplEngine.registerHelper('hump', function (str, type) {
                let name = '';
                let tmp = str.split('_');
                for (let i = 0; i < tmp.length; i++) {
                    if (i > 0 || type == 'ucfirst') {
                        name += tmp[i].charAt(0).toUpperCase() + tmp[i].slice(1);
                    } else {
                        name += tmp[i];
                    }
                }
                return name;
            });

            // write file Router.ts in OUTPUT_DIR/router/
            let routerContent = TplEngine.render('router/router', {
                infos: gatewayInfoList,
            });
            await LibFs.writeFile(LibPath.join(OUTPUT_DIR, 'router', 'Router.ts'), routerContent);

            // write file RouterAPITest.ts in OUTPUT_DIR/router/
            let testContent = TplEngine.render('router/test', {
                infos: gatewayInfoList,
            });
            await LibFs.writeFile(LibPath.join(OUTPUT_DIR, 'router', 'RouterAPITest.ts'), testContent);

            // write file ${gatewayApiName}.ts in OUTPUT_DIR/router/${gatewayApiService}/
            for (let gatewayInfo of gatewayInfoList) {
                const relativePath = this._protoMsgImportInfos[`${gatewayInfo.packageName}${gatewayInfo.serviceName}`].protoFile.relativePath;
                await mkdir(LibPath.join(OUTPUT_DIR, 'router', relativePath, gatewayInfo.serviceName));

                let apiContent = TplEngine.render('router/api', {
                    info: gatewayInfo,
                });

                await LibFs.writeFile(LibPath.join(OUTPUT_DIR, 'router', relativePath, gatewayInfo.serviceName, gatewayInfo.fileName + '.ts'), apiContent);
            }

            // make client dir in OUTPUT_DIR
            if (API_GATEWAY_CLIENT) {
                await mkdir(LibPath.join(OUTPUT_DIR, 'client'));

                // write file Router.ts in OUTPUT_DIR/router/
                TplEngine.registerHelper('lcfirst', lcfirst);
                let clientContent = TplEngine.render('client/client', {
                    infos: gatewayInfoList,
                });
                await LibFs.writeFile(LibPath.join(OUTPUT_DIR, 'client', 'SasdnAPI.ts'), clientContent);
            }
        }
    }
}

GatewayCLI.instance().run().catch((err: Error) => {
    console.log('err: ', err.message);
});