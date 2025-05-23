import { IS_REACT_19 } from '@internal/utils/react-is.js'
import type { PayloadAction } from '@reduxjs/toolkit'
import { createSlice, createStore } from '@reduxjs/toolkit'
import * as rtl from '@testing-library/react'
import React, { Suspense, useEffect, useState } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import type { ConnectedProps } from 'react-redux'
import { Provider, connect, useDispatch, useSelector } from 'react-redux'

const IS_REACT_18 = React.version.startsWith('18')

describe('New v8 serverState behavior', () => {
  interface State {
    count: number
    data: string[]
  }
  const initialState: State = {
    count: 0,
    data: [],
  }

  const dataSlice = createSlice({
    name: 'data',
    initialState,
    reducers: {
      fakeLoadData(state, action: PayloadAction<string>) {
        state.data.push(action.payload)
      },
      increaseCount(state) {
        state.count++
      },
    },
  })

  const { fakeLoadData, increaseCount } = dataSlice.actions

  const selectCount = (state: State) => state.count

  function useIsHydrated() {
    // Get weird Babel-errors when I try to destruct arrays..
    const hydratedState = useState(false)
    const hydrated = hydratedState[0]
    const setHydrated = hydratedState[1]

    // When this effect runs and the component being hydrated isn't
    // exactly the same thing but close enough for this demo.
    useEffect(() => {
      setHydrated(true)
    }, [setHydrated])

    return hydrated
  }

  function GlobalCountButton() {
    const isHydrated = useIsHydrated()
    const count = useSelector(selectCount)
    const dispatch = useDispatch()

    return (
      <button
        disabled={!isHydrated}
        style={{ marginLeft: '24px' }}
        onClick={() => dispatch(increaseCount())}
      >
        useSelector:
        {isHydrated
          ? `Hydrated. Count: ${count}`
          : `Not hydrated. Count: ${count}`}
      </button>
    )
  }

  const mapState = (state: State) => ({
    count: selectCount(state),
  })

  const gcbConnector = connect(mapState)
  type PropsFromRedux = ConnectedProps<typeof gcbConnector>

  function GlobalCountButtonConnect({ count, dispatch }: PropsFromRedux) {
    const isHydrated = useIsHydrated()

    return (
      <button
        disabled={!isHydrated}
        style={{ marginLeft: '24px' }}
        onClick={() => dispatch(increaseCount())}
      >
        Connect:
        {isHydrated
          ? `Hydrated. Count: ${count}`
          : `Not hydrated. Count: ${count}`}
      </button>
    )
  }

  const ConnectedGlobalCountButtonConnect = gcbConnector(
    GlobalCountButtonConnect,
  )

  function App() {
    return (
      <div>
        <Suspense fallback={<Spinner />}>
          <GlobalCountButton />
          <ConnectedGlobalCountButtonConnect />
        </Suspense>
      </div>
    )
  }

  const Spinner = () => <div />

  const consoleErrorSpy = vi
    .spyOn(console, 'error')
    .mockImplementation(() => {})

  afterEach(() => {
    vi.clearAllMocks()
  })

  afterAll(() => {
    vi.restoreAllMocks()
  })

  it('Handles hydration correctly', async () => {
    const ssrStore = createStore(dataSlice.reducer)

    // Simulating loading all data before rendering the app
    ssrStore.dispatch(fakeLoadData("Wait, it doesn't wait for React to load?"))
    ssrStore.dispatch(fakeLoadData('How does this even work?'))
    ssrStore.dispatch(fakeLoadData('I like marshmallows'))

    const markup = renderToString(
      <Provider store={ssrStore}>
        <App />
      </Provider>,
    )

    // Pretend we have server-rendered HTML
    const rootDiv = document.createElement('div')
    document.body.appendChild(rootDiv)
    rootDiv.innerHTML = markup

    const initialState = ssrStore.getState()
    const clientStore = createStore(dataSlice.reducer, initialState)

    // Intentionally update client store to change state vs server
    clientStore.dispatch(increaseCount())

    // First hydration attempt with just the store should fail due to mismatch
    await rtl.act(async () => {
      hydrateRoot(
        rootDiv,
        <Provider store={clientStore}>
          <App />
        </Provider>,
        {
          onRecoverableError: IS_REACT_19
            ? (error, errorInfo) => {
                console.error(error)
              }
            : undefined,
        },
      )
    })

    const { lastCall = [] } = consoleErrorSpy.mock
    const [errorArg] = lastCall
    expect(errorArg).toBeInstanceOf(Error)

    if (IS_REACT_19) {
      expect(consoleErrorSpy).toHaveBeenCalledOnce()

      expect(errorArg.message).toMatch(
        /Hydration failed because the server rendered HTML didn't match the client/,
      )
    } else if (IS_REACT_18) {
      expect(consoleErrorSpy).toHaveBeenCalledTimes(8)

      expect(errorArg.message).toMatch(/There was an error while hydrating/)
    }

    vi.clearAllMocks()

    expect(consoleErrorSpy).not.toHaveBeenCalled()

    document.body.removeChild(rootDiv)

    const clientStore2 = createStore(dataSlice.reducer, initialState)
    clientStore2.dispatch(increaseCount())

    const rootDiv2 = document.createElement('div')
    document.body.appendChild(rootDiv2)
    rootDiv2.innerHTML = markup

    // Second attempt should pass, because we provide serverState
    await rtl.act(async () => {
      hydrateRoot(
        rootDiv2,
        <Provider store={clientStore2} serverState={initialState}>
          <App />
        </Provider>,
      )
    })

    expect(consoleErrorSpy).not.toHaveBeenCalled()

    // Buttons should both exist, and have the updated count due to later render
    const button1 = rtl.screen.getByText('useSelector:Hydrated. Count: 1')
    expect(button1).not.toBeNull()
    const button2 = rtl.screen.getByText('Connect:Hydrated. Count: 1')
    expect(button2).not.toBeNull()
  })
})
