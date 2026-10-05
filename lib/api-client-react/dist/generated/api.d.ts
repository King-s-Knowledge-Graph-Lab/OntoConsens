import type { QueryKey, UseMutationOptions, UseMutationResult, UseQueryOptions, UseQueryResult } from '@tanstack/react-query';
import type { AuthCredentials, AuthResponse, ConversationExportPayload, ErrorResponse, ExportPayload, HealthStatus, JoinProjectInput, ListModeratorChatMessages200, Member, ModeratorConfigInput, ModeratorStatus, ProjectDetail, ProjectInput, ProjectSummary, Property, PropertyInput, PropertyUpdate, ReadyInput, RegisterInput, UpdateApiKeyInput, User, WsTicket } from './api.schemas';
import { customFetch } from '../custom-fetch';
import type { ErrorType, BodyType } from '../custom-fetch';
type AwaitedInput<T> = PromiseLike<T> | T;
type Awaited<O> = O extends AwaitedInput<infer T> ? T : never;
type SecondParameter<T extends (...args: never) => unknown> = Parameters<T>[1];
export declare const getHealthCheckUrl: () => string;
/**
 * Returns server health status
 * @summary Health check
 */
export declare const healthCheck: (options?: Parameters<typeof customFetch>[1]) => Promise<HealthStatus>;
export declare const getHealthCheckQueryKey: () => readonly ["/api/healthz"];
export declare const getHealthCheckQueryOptions: <TData = Awaited<ReturnType<typeof healthCheck>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof healthCheck>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof healthCheck>>, TError, TData> & {
    queryKey: QueryKey;
};
export type HealthCheckQueryResult = NonNullable<Awaited<ReturnType<typeof healthCheck>>>;
export type HealthCheckQueryError = ErrorType<unknown>;
/**
 * @summary Health check
 */
export declare function useHealthCheck<TData = Awaited<ReturnType<typeof healthCheck>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof healthCheck>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getRegisterUrl: () => string;
/**
 * @summary Register a new account
 */
export declare const register: (registerInput: RegisterInput, options?: Parameters<typeof customFetch>[1]) => Promise<AuthResponse>;
export declare const getRegisterMutationOptions: <TError = ErrorType<ErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof register>>, TError, {
        data: BodyType<RegisterInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof register>>, TError, {
    data: BodyType<RegisterInput>;
}, TContext>;
export type RegisterMutationResult = NonNullable<Awaited<ReturnType<typeof register>>>;
export type RegisterMutationBody = BodyType<RegisterInput>;
export type RegisterMutationError = ErrorType<ErrorResponse>;
/**
* @summary Register a new account
*/
export declare const useRegister: <TError = ErrorType<ErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof register>>, TError, {
        data: BodyType<RegisterInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof register>>, TError, {
    data: BodyType<RegisterInput>;
}, TContext>;
export declare const getLoginUrl: () => string;
/**
 * @summary Log in
 */
export declare const login: (authCredentials: AuthCredentials, options?: Parameters<typeof customFetch>[1]) => Promise<AuthResponse>;
export declare const getLoginMutationOptions: <TError = ErrorType<ErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof login>>, TError, {
        data: BodyType<AuthCredentials>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof login>>, TError, {
    data: BodyType<AuthCredentials>;
}, TContext>;
export type LoginMutationResult = NonNullable<Awaited<ReturnType<typeof login>>>;
export type LoginMutationBody = BodyType<AuthCredentials>;
export type LoginMutationError = ErrorType<ErrorResponse>;
/**
* @summary Log in
*/
export declare const useLogin: <TError = ErrorType<ErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof login>>, TError, {
        data: BodyType<AuthCredentials>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof login>>, TError, {
    data: BodyType<AuthCredentials>;
}, TContext>;
export declare const getLogoutUrl: () => string;
/**
 * @summary Log out
 */
export declare const logout: (options?: Parameters<typeof customFetch>[1]) => Promise<void>;
export declare const getLogoutMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof logout>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof logout>>, TError, void, TContext>;
export type LogoutMutationResult = NonNullable<Awaited<ReturnType<typeof logout>>>;
export type LogoutMutationError = ErrorType<unknown>;
/**
* @summary Log out
*/
export declare const useLogout: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof logout>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof logout>>, TError, void, TContext>;
export declare const getGetMeUrl: () => string;
/**
 * @summary Get the current user
 */
export declare const getMe: (options?: Parameters<typeof customFetch>[1]) => Promise<User>;
export declare const getGetMeQueryKey: () => readonly ["/api/auth/me"];
export declare const getGetMeQueryOptions: <TData = Awaited<ReturnType<typeof getMe>>, TError = ErrorType<ErrorResponse>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getMe>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getMe>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetMeQueryResult = NonNullable<Awaited<ReturnType<typeof getMe>>>;
export type GetMeQueryError = ErrorType<ErrorResponse>;
/**
 * @summary Get the current user
 */
export declare function useGetMe<TData = Awaited<ReturnType<typeof getMe>>, TError = ErrorType<ErrorResponse>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getMe>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getUpdateApiKeyUrl: () => string;
/**
 * Every project this user creates uses this key for its AI moderator. Never returned by any endpoint once saved -- only whether one is configured.
 * @summary Save or replace the OpenAI API key on the current account
 */
export declare const updateApiKey: (updateApiKeyInput: UpdateApiKeyInput, options?: Parameters<typeof customFetch>[1]) => Promise<User>;
export declare const getUpdateApiKeyMutationOptions: <TError = ErrorType<ErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateApiKey>>, TError, {
        data: BodyType<UpdateApiKeyInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof updateApiKey>>, TError, {
    data: BodyType<UpdateApiKeyInput>;
}, TContext>;
export type UpdateApiKeyMutationResult = NonNullable<Awaited<ReturnType<typeof updateApiKey>>>;
export type UpdateApiKeyMutationBody = BodyType<UpdateApiKeyInput>;
export type UpdateApiKeyMutationError = ErrorType<ErrorResponse>;
/**
* @summary Save or replace the OpenAI API key on the current account
*/
export declare const useUpdateApiKey: <TError = ErrorType<ErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateApiKey>>, TError, {
        data: BodyType<UpdateApiKeyInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof updateApiKey>>, TError, {
    data: BodyType<UpdateApiKeyInput>;
}, TContext>;
export declare const getListProjectsUrl: () => string;
/**
 * @summary List projects the current user belongs to
 */
export declare const listProjects: (options?: Parameters<typeof customFetch>[1]) => Promise<ProjectSummary[]>;
export declare const getListProjectsQueryKey: () => readonly ["/api/projects"];
export declare const getListProjectsQueryOptions: <TData = Awaited<ReturnType<typeof listProjects>>, TError = ErrorType<ErrorResponse>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listProjects>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof listProjects>>, TError, TData> & {
    queryKey: QueryKey;
};
export type ListProjectsQueryResult = NonNullable<Awaited<ReturnType<typeof listProjects>>>;
export type ListProjectsQueryError = ErrorType<ErrorResponse>;
/**
 * @summary List projects the current user belongs to
 */
export declare function useListProjects<TData = Awaited<ReturnType<typeof listProjects>>, TError = ErrorType<ErrorResponse>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listProjects>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getCreateProjectUrl: () => string;
/**
 * @summary Create a project from an uploaded ontology file
 */
export declare const createProject: (projectInput: ProjectInput, options?: Parameters<typeof customFetch>[1]) => Promise<ProjectSummary>;
export declare const getCreateProjectMutationOptions: <TError = ErrorType<ErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createProject>>, TError, {
        data: BodyType<ProjectInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof createProject>>, TError, {
    data: BodyType<ProjectInput>;
}, TContext>;
export type CreateProjectMutationResult = NonNullable<Awaited<ReturnType<typeof createProject>>>;
export type CreateProjectMutationBody = BodyType<ProjectInput>;
export type CreateProjectMutationError = ErrorType<ErrorResponse>;
/**
* @summary Create a project from an uploaded ontology file
*/
export declare const useCreateProject: <TError = ErrorType<ErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createProject>>, TError, {
        data: BodyType<ProjectInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof createProject>>, TError, {
    data: BodyType<ProjectInput>;
}, TContext>;
export declare const getJoinProjectUrl: () => string;
/**
 * @summary Join a project using an invite code
 */
export declare const joinProject: (joinProjectInput: JoinProjectInput, options?: Parameters<typeof customFetch>[1]) => Promise<ProjectSummary>;
export declare const getJoinProjectMutationOptions: <TError = ErrorType<ErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof joinProject>>, TError, {
        data: BodyType<JoinProjectInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof joinProject>>, TError, {
    data: BodyType<JoinProjectInput>;
}, TContext>;
export type JoinProjectMutationResult = NonNullable<Awaited<ReturnType<typeof joinProject>>>;
export type JoinProjectMutationBody = BodyType<JoinProjectInput>;
export type JoinProjectMutationError = ErrorType<ErrorResponse>;
/**
* @summary Join a project using an invite code
*/
export declare const useJoinProject: <TError = ErrorType<ErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof joinProject>>, TError, {
        data: BodyType<JoinProjectInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof joinProject>>, TError, {
    data: BodyType<JoinProjectInput>;
}, TContext>;
export declare const getGetProjectUrl: (id: number) => string;
/**
 * @summary Get project details, members and graph
 */
export declare const getProject: (id: number, options?: Parameters<typeof customFetch>[1]) => Promise<ProjectDetail>;
export declare const getGetProjectQueryKey: (id: number) => readonly [`/api/projects/${number}`];
export declare const getGetProjectQueryOptions: <TData = Awaited<ReturnType<typeof getProject>>, TError = ErrorType<ErrorResponse>>(id: number, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getProject>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getProject>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetProjectQueryResult = NonNullable<Awaited<ReturnType<typeof getProject>>>;
export type GetProjectQueryError = ErrorType<ErrorResponse>;
/**
 * @summary Get project details, members and graph
 */
export declare function useGetProject<TData = Awaited<ReturnType<typeof getProject>>, TError = ErrorType<ErrorResponse>>(id: number, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getProject>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getDeleteProjectUrl: (id: number) => string;
/**
 * @summary Delete a project (owner only) — removes it for every member
 */
export declare const deleteProject: (id: number, options?: Parameters<typeof customFetch>[1]) => Promise<void>;
export declare const getDeleteProjectMutationOptions: <TError = ErrorType<ErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof deleteProject>>, TError, {
        id: number;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof deleteProject>>, TError, {
    id: number;
}, TContext>;
export type DeleteProjectMutationResult = NonNullable<Awaited<ReturnType<typeof deleteProject>>>;
export type DeleteProjectMutationError = ErrorType<ErrorResponse>;
/**
* @summary Delete a project (owner only) — removes it for every member
*/
export declare const useDeleteProject: <TError = ErrorType<ErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof deleteProject>>, TError, {
        id: number;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof deleteProject>>, TError, {
    id: number;
}, TContext>;
export declare const getSetReadyUrl: (id: number) => string;
/**
 * @summary Toggle current member's ready-for-consensus state
 */
export declare const setReady: (id: number, readyInput: ReadyInput, options?: Parameters<typeof customFetch>[1]) => Promise<Member>;
export declare const getSetReadyMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof setReady>>, TError, {
        id: number;
        data: BodyType<ReadyInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof setReady>>, TError, {
    id: number;
    data: BodyType<ReadyInput>;
}, TContext>;
export type SetReadyMutationResult = NonNullable<Awaited<ReturnType<typeof setReady>>>;
export type SetReadyMutationBody = BodyType<ReadyInput>;
export type SetReadyMutationError = ErrorType<unknown>;
/**
* @summary Toggle current member's ready-for-consensus state
*/
export declare const useSetReady: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof setReady>>, TError, {
        id: number;
        data: BodyType<ReadyInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof setReady>>, TError, {
    id: number;
    data: BodyType<ReadyInput>;
}, TContext>;
export declare const getCreateWsTicketUrl: (id: number) => string;
/**
 * @summary Create a short-lived ticket to open the realtime connection
 */
export declare const createWsTicket: (id: number, options?: Parameters<typeof customFetch>[1]) => Promise<WsTicket>;
export declare const getCreateWsTicketMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createWsTicket>>, TError, {
        id: number;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof createWsTicket>>, TError, {
    id: number;
}, TContext>;
export type CreateWsTicketMutationResult = NonNullable<Awaited<ReturnType<typeof createWsTicket>>>;
export type CreateWsTicketMutationError = ErrorType<unknown>;
/**
* @summary Create a short-lived ticket to open the realtime connection
*/
export declare const useCreateWsTicket: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createWsTicket>>, TError, {
        id: number;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof createWsTicket>>, TError, {
    id: number;
}, TContext>;
export declare const getCreateUserWsTicketUrl: () => string;
/**
 * @summary Create a short-lived ticket to open a user-scoped realtime connection (not tied to a single project), used to learn immediately when any of the current user's projects is deleted
 */
export declare const createUserWsTicket: (options?: Parameters<typeof customFetch>[1]) => Promise<WsTicket>;
export declare const getCreateUserWsTicketMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createUserWsTicket>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof createUserWsTicket>>, TError, void, TContext>;
export type CreateUserWsTicketMutationResult = NonNullable<Awaited<ReturnType<typeof createUserWsTicket>>>;
export type CreateUserWsTicketMutationError = ErrorType<unknown>;
/**
* @summary Create a short-lived ticket to open a user-scoped realtime connection (not tied to a single project), used to learn immediately when any of the current user's projects is deleted
*/
export declare const useCreateUserWsTicket: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createUserWsTicket>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof createUserWsTicket>>, TError, void, TContext>;
export declare const getListPropertiesUrl: (id: number) => string;
/**
 * @summary List properties visible to the current user for a project
 */
export declare const listProperties: (id: number, options?: Parameters<typeof customFetch>[1]) => Promise<Property[]>;
export declare const getListPropertiesQueryKey: (id: number) => readonly [`/api/projects/${number}/properties`];
export declare const getListPropertiesQueryOptions: <TData = Awaited<ReturnType<typeof listProperties>>, TError = ErrorType<unknown>>(id: number, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listProperties>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof listProperties>>, TError, TData> & {
    queryKey: QueryKey;
};
export type ListPropertiesQueryResult = NonNullable<Awaited<ReturnType<typeof listProperties>>>;
export type ListPropertiesQueryError = ErrorType<unknown>;
/**
 * @summary List properties visible to the current user for a project
 */
export declare function useListProperties<TData = Awaited<ReturnType<typeof listProperties>>, TError = ErrorType<unknown>>(id: number, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listProperties>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getCreatePropertyUrl: (id: number) => string;
/**
 * @summary Propose a new property on a class
 */
export declare const createProperty: (id: number, propertyInput: PropertyInput, options?: Parameters<typeof customFetch>[1]) => Promise<Property>;
export declare const getCreatePropertyMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createProperty>>, TError, {
        id: number;
        data: BodyType<PropertyInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof createProperty>>, TError, {
    id: number;
    data: BodyType<PropertyInput>;
}, TContext>;
export type CreatePropertyMutationResult = NonNullable<Awaited<ReturnType<typeof createProperty>>>;
export type CreatePropertyMutationBody = BodyType<PropertyInput>;
export type CreatePropertyMutationError = ErrorType<unknown>;
/**
* @summary Propose a new property on a class
*/
export declare const useCreateProperty: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createProperty>>, TError, {
        id: number;
        data: BodyType<PropertyInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof createProperty>>, TError, {
    id: number;
    data: BodyType<PropertyInput>;
}, TContext>;
export declare const getUpdatePropertyUrl: (id: number, propertyId: number) => string;
/**
 * @summary Refine the text of a property you proposed
 */
export declare const updateProperty: (id: number, propertyId: number, propertyUpdate: PropertyUpdate, options?: Parameters<typeof customFetch>[1]) => Promise<Property>;
export declare const getUpdatePropertyMutationOptions: <TError = ErrorType<ErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateProperty>>, TError, {
        id: number;
        propertyId: number;
        data: BodyType<PropertyUpdate>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof updateProperty>>, TError, {
    id: number;
    propertyId: number;
    data: BodyType<PropertyUpdate>;
}, TContext>;
export type UpdatePropertyMutationResult = NonNullable<Awaited<ReturnType<typeof updateProperty>>>;
export type UpdatePropertyMutationBody = BodyType<PropertyUpdate>;
export type UpdatePropertyMutationError = ErrorType<ErrorResponse>;
/**
* @summary Refine the text of a property you proposed
*/
export declare const useUpdateProperty: <TError = ErrorType<ErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateProperty>>, TError, {
        id: number;
        propertyId: number;
        data: BodyType<PropertyUpdate>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof updateProperty>>, TError, {
    id: number;
    propertyId: number;
    data: BodyType<PropertyUpdate>;
}, TContext>;
export declare const getRetractPropertyUrl: (id: number, propertyId: number) => string;
/**
 * @summary Remove your own contribution (proposal or agreement) from a property
 */
export declare const retractProperty: (id: number, propertyId: number, options?: Parameters<typeof customFetch>[1]) => Promise<void>;
export declare const getRetractPropertyMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof retractProperty>>, TError, {
        id: number;
        propertyId: number;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof retractProperty>>, TError, {
    id: number;
    propertyId: number;
}, TContext>;
export type RetractPropertyMutationResult = NonNullable<Awaited<ReturnType<typeof retractProperty>>>;
export type RetractPropertyMutationError = ErrorType<unknown>;
/**
* @summary Remove your own contribution (proposal or agreement) from a property
*/
export declare const useRetractProperty: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof retractProperty>>, TError, {
        id: number;
        propertyId: number;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof retractProperty>>, TError, {
    id: number;
    propertyId: number;
}, TContext>;
export declare const getAgreePropertyUrl: (id: number, propertyId: number) => string;
/**
 * @summary Add your color to a property stack to agree to retain it
 */
export declare const agreeProperty: (id: number, propertyId: number, options?: Parameters<typeof customFetch>[1]) => Promise<Property>;
export declare const getAgreePropertyMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof agreeProperty>>, TError, {
        id: number;
        propertyId: number;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof agreeProperty>>, TError, {
    id: number;
    propertyId: number;
}, TContext>;
export type AgreePropertyMutationResult = NonNullable<Awaited<ReturnType<typeof agreeProperty>>>;
export type AgreePropertyMutationError = ErrorType<unknown>;
/**
* @summary Add your color to a property stack to agree to retain it
*/
export declare const useAgreeProperty: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof agreeProperty>>, TError, {
        id: number;
        propertyId: number;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof agreeProperty>>, TError, {
    id: number;
    propertyId: number;
}, TContext>;
export declare const getExportProjectUrl: (id: number) => string;
/**
 * @summary Export classes and fully-agreed properties as JSON
 */
export declare const exportProject: (id: number, options?: Parameters<typeof customFetch>[1]) => Promise<ExportPayload>;
export declare const getExportProjectQueryKey: (id: number) => readonly [`/api/projects/${number}/export`];
export declare const getExportProjectQueryOptions: <TData = Awaited<ReturnType<typeof exportProject>>, TError = ErrorType<unknown>>(id: number, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof exportProject>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof exportProject>>, TError, TData> & {
    queryKey: QueryKey;
};
export type ExportProjectQueryResult = NonNullable<Awaited<ReturnType<typeof exportProject>>>;
export type ExportProjectQueryError = ErrorType<unknown>;
/**
 * @summary Export classes and fully-agreed properties as JSON
 */
export declare function useExportProject<TData = Awaited<ReturnType<typeof exportProject>>, TError = ErrorType<unknown>>(id: number, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof exportProject>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getExportConversationUrl: (id: number) => string;
/**
 * @summary Export the full moderator conversation history (transcripts, system events, and interventions) as flat, analysis-ready JSON. Unlike /export, available at any point in the project's lifecycle -- not gated on full agreement.
 */
export declare const exportConversation: (id: number, options?: Parameters<typeof customFetch>[1]) => Promise<ConversationExportPayload>;
export declare const getExportConversationQueryKey: (id: number) => readonly [`/api/projects/${number}/export-conversation`];
export declare const getExportConversationQueryOptions: <TData = Awaited<ReturnType<typeof exportConversation>>, TError = ErrorType<unknown>>(id: number, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof exportConversation>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof exportConversation>>, TError, TData> & {
    queryKey: QueryKey;
};
export type ExportConversationQueryResult = NonNullable<Awaited<ReturnType<typeof exportConversation>>>;
export type ExportConversationQueryError = ErrorType<unknown>;
/**
 * @summary Export the full moderator conversation history (transcripts, system events, and interventions) as flat, analysis-ready JSON. Unlike /export, available at any point in the project's lifecycle -- not gated on full agreement.
 */
export declare function useExportConversation<TData = Awaited<ReturnType<typeof exportConversation>>, TError = ErrorType<unknown>>(id: number, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof exportConversation>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetModeratorStatusUrl: (id: number) => string;
/**
 * @summary Get whether the AI moderator is on for the CURRENT member, and whether it's usable at all for this project
 */
export declare const getModeratorStatus: (id: number, options?: Parameters<typeof customFetch>[1]) => Promise<ModeratorStatus>;
export declare const getGetModeratorStatusQueryKey: (id: number) => readonly [`/api/projects/${number}/moderator`];
export declare const getGetModeratorStatusQueryOptions: <TData = Awaited<ReturnType<typeof getModeratorStatus>>, TError = ErrorType<unknown>>(id: number, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getModeratorStatus>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getModeratorStatus>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetModeratorStatusQueryResult = NonNullable<Awaited<ReturnType<typeof getModeratorStatus>>>;
export type GetModeratorStatusQueryError = ErrorType<unknown>;
/**
 * @summary Get whether the AI moderator is on for the CURRENT member, and whether it's usable at all for this project
 */
export declare function useGetModeratorStatus<TData = Awaited<ReturnType<typeof getModeratorStatus>>, TError = ErrorType<unknown>>(id: number, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getModeratorStatus>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getConfigureModeratorUrl: (id: number) => string;
/**
 * @summary Turn the AI moderator on for the CURRENT member only (their own mic and transcript), using the project creator's saved OpenAI API key. Does not affect any other member.
 */
export declare const configureModerator: (id: number, moderatorConfigInput?: ModeratorConfigInput, options?: Parameters<typeof customFetch>[1]) => Promise<ModeratorStatus>;
export declare const getConfigureModeratorMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof configureModerator>>, TError, {
        id: number;
        data?: BodyType<ModeratorConfigInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof configureModerator>>, TError, {
    id: number;
    data?: BodyType<ModeratorConfigInput>;
}, TContext>;
export type ConfigureModeratorMutationResult = NonNullable<Awaited<ReturnType<typeof configureModerator>>>;
export type ConfigureModeratorMutationBody = BodyType<ModeratorConfigInput> | undefined;
export type ConfigureModeratorMutationError = ErrorType<unknown>;
/**
* @summary Turn the AI moderator on for the CURRENT member only (their own mic and transcript), using the project creator's saved OpenAI API key. Does not affect any other member.
*/
export declare const useConfigureModerator: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof configureModerator>>, TError, {
        id: number;
        data?: BodyType<ModeratorConfigInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof configureModerator>>, TError, {
    id: number;
    data?: BodyType<ModeratorConfigInput>;
}, TContext>;
export declare const getDisableModeratorUrl: (id: number) => string;
/**
 * @summary Turn the AI moderator off for the CURRENT member only
 */
export declare const disableModerator: (id: number, options?: Parameters<typeof customFetch>[1]) => Promise<ModeratorStatus>;
export declare const getDisableModeratorMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof disableModerator>>, TError, {
        id: number;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof disableModerator>>, TError, {
    id: number;
}, TContext>;
export type DisableModeratorMutationResult = NonNullable<Awaited<ReturnType<typeof disableModerator>>>;
export type DisableModeratorMutationError = ErrorType<unknown>;
/**
* @summary Turn the AI moderator off for the CURRENT member only
*/
export declare const useDisableModerator: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof disableModerator>>, TError, {
        id: number;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof disableModerator>>, TError, {
    id: number;
}, TContext>;
export declare const getListModeratorChatMessagesUrl: (id: number) => string;
/**
 * @summary Full persisted moderator chat history for this project (intro, system, transcript, and intervention messages), visible to every member regardless of their own mic state.
 */
export declare const listModeratorChatMessages: (id: number, options?: Parameters<typeof customFetch>[1]) => Promise<ListModeratorChatMessages200>;
export declare const getListModeratorChatMessagesQueryKey: (id: number) => readonly [`/api/projects/${number}/moderator/messages`];
export declare const getListModeratorChatMessagesQueryOptions: <TData = Awaited<ReturnType<typeof listModeratorChatMessages>>, TError = ErrorType<unknown>>(id: number, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listModeratorChatMessages>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof listModeratorChatMessages>>, TError, TData> & {
    queryKey: QueryKey;
};
export type ListModeratorChatMessagesQueryResult = NonNullable<Awaited<ReturnType<typeof listModeratorChatMessages>>>;
export type ListModeratorChatMessagesQueryError = ErrorType<unknown>;
/**
 * @summary Full persisted moderator chat history for this project (intro, system, transcript, and intervention messages), visible to every member regardless of their own mic state.
 */
export declare function useListModeratorChatMessages<TData = Awaited<ReturnType<typeof listModeratorChatMessages>>, TError = ErrorType<unknown>>(id: number, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listModeratorChatMessages>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export {};
//# sourceMappingURL=api.d.ts.map